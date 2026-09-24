import { Langfuse } from "langfuse";

import { env } from "../config/env.js";
import { logger } from "./logger.js";

// ─── Fail-safe LLM observability ─────────────────────────────────────────────
//
// Wraps Langfuse so that observability can NEVER break the request path:
// - disabled entirely unless LANGFUSE_HOST/BASE_URL + PUBLIC_KEY + SECRET_KEY
// - every call is wrapped; failures are logged at debug level and ignored
// - raw prompt/completion content is only sent when LANGFUSE_LOG_CONTENT=true.
//   By default only sizes, latencies, and metadata leave the process — no
//   contract text.

const NOOP_SPAN: ObsSpan = {
  end: () => undefined,
  generation: () => undefined,
};

const NOOP_TRACE: ObsTrace = {
  span: () => NOOP_SPAN,
  generation: () => undefined,
  end: () => undefined,
};

let client: Langfuse | null = null;
let clientResolved = false;

function getClient(): Langfuse | null {
  if (clientResolved) {
    return client;
  }

  clientResolved = true;

  // Accepts either LANGFUSE_HOST or LANGFUSE_BASE_URL.
  const host = env.LANGFUSE_HOST || env.LANGFUSE_BASE_URL;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;

  if (!host || !publicKey || !secretKey) {
    logger.info(
      "Observability: LANGFUSE_* not fully configured — LLM tracing disabled.",
    );

    return null;
  }

  try {
    client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl: host,
      requestTimeout: 5_000,
    });

    logger.info(
      { host },
      "Observability: Langfuse tracing enabled.",
    );
  } catch (error) {
    logger.warn(
      { error },
      "Observability: Langfuse initialisation failed — tracing disabled.",
    );

    client = null;
  }

  return client;
}

function contentOf(
  text: string | null | undefined,
): Record<string, unknown> | null {
  if (!text) {
    return null;
  }

  return env.LANGFUSE_LOG_CONTENT === "true"
    ? { text }
    : { chars: text.length };
}

function safe<T>(what: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (error) {
    logger.debug(
      { what, error },
      "Observability call failed (ignored).",
    );

    return null;
  }
}

export interface ObsGeneration {
  name: string;
  model?: string | undefined;
  provider?: string | undefined;

  inputText?: string | null;
  outputText?: string | null;

  latencyMs?: number | undefined;
  firstTokenMs?: number | undefined;

  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" | undefined;
  statusMessage?: string | undefined;
}

export interface ObsSpan {
  end(metadata?: Record<string, unknown>, statusMessage?: string): void;
  generation(generation: ObsGeneration): void;
}

export interface ObsTrace {
  span(name: string, metadata?: Record<string, unknown>): ObsSpan;
  generation(generation: ObsGeneration): void;
  end(metadata?: Record<string, unknown>, statusMessage?: string): void;
}

/** Starts a trace; returns a no-op trace when Langfuse is disabled. */
export function startTrace(
  name: string,
  metadata: Record<string, unknown> = {},
  tags: string[] = [],
): ObsTrace {
  const lf = getClient();

  if (!lf) {
    return NOOP_TRACE;
  }

  return safe(
    "trace.start",
    () => {
      const trace = lf.trace({
        name,
        metadata: { env: env.NODE_ENV, ...metadata },
        tags,
      });

      const toGenerationInput = (gen: ObsGeneration) => ({
        name: gen.name,
        ...(gen.model ? { model: gen.model } : {}),
        input: contentOf(gen.inputText),
        output: contentOf(gen.outputText),
        metadata: {
          ...gen.metadata,
          provider: gen.provider,
          latencyMs: gen.latencyMs,
          firstTokenMs: gen.firstTokenMs,
        },
        ...(gen.level ? { level: gen.level } : {}),
        ...(gen.statusMessage ? { statusMessage: gen.statusMessage } : {}),
      });

      const obsTrace: ObsTrace = {
        span(spanName, spanMetadata = {}) {
          return (
            safe("trace.span", () => {
              const span = trace.span({ name: spanName, metadata: spanMetadata });

              return {
                end(endMetadata, statusMessage) {
                  safe("span.end", () =>
                    span.end({
                      metadata: endMetadata,
                      ...(statusMessage ? { statusMessage } : {}),
                    }),
                  );
                },
                generation(gen) {
                  safe("span.generation", () =>
                    span.generation(toGenerationInput(gen)),
                  );
                },
              } satisfies ObsSpan;
            }) ?? NOOP_SPAN
          );
        },

        generation(gen) {
          safe("trace.generation", () =>
            trace.generation(toGenerationInput(gen)),
          );
        },

        end(endMetadata, statusMessage) {
          // Langfuse v2 traces auto-complete; surface closing metadata
          // through trace.update instead of an explicit end event.
          safe("trace.end", () =>
            trace.update({
              metadata: {
                ...endMetadata,
                ...(statusMessage ? { statusMessage } : {}),
              },
            }),
          );
        },
      };

      return obsTrace;
    },
  ) ?? NOOP_TRACE;
}

/** Flushes queued observations; safe to call multiple times. */
export async function flushObservability(): Promise<void> {
  if (!client) {
    return;
  }

  try {
    await client.flushAsync();
  } catch (error) {
    logger.debug(
      { error },
      "Observability flush failed (ignored).",
    );
  }
}

export function isObservabilityEnabled(): boolean {
  return getClient() !== null;
}

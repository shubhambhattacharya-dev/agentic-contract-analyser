// backend/src/services/ai/provider.service.ts

import { groq } from "@ai-sdk/groq";
import { GoogleGenAI } from "@google/genai";
import { generateText, streamText } from "ai";

import { modelConfig } from "../../config/env.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { startTrace } from "../../lib/observability.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2 as const;
const RETRY_DELAY_MS = 500 as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type GenerationProvider = "groq" | "gemini";

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface GenerationRequest {
  system?: string;
  prompt: string;
  options?: GenerationOptions;
}

export interface GenerationResponse {
  text: string;
  provider: GenerationProvider;
  model: string;
}

interface ProviderConfig {
  provider: GenerationProvider;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

// ─── Clients ──────────────────────────────────────────────────────────────────

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new AIProviderError(
      "Gemini API key is not configured.",
    );
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
  }

  return geminiClient;
}

// ─── Test Support ─────────────────────────────────────────────────────────────

export function resetAIClients(): void {
  geminiClient = null;
}

// ─── Validation ────────────────────────────────────────────────────────────────

function validateRequest(
  request: GenerationRequest,
): void {
  if (
    request === null ||
    typeof request !== "object"
  ) {
    throw new AIProviderError(
      "Generation request is required.",
    );
  }

  if (
    typeof request.prompt !== "string" ||
    !request.prompt.trim()
  ) {
    throw new AIProviderError(
      "Generation prompt cannot be empty.",
    );
  }

  const temperature =
    request.options?.temperature;

  if (temperature !== undefined) {
    if (
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      throw new AIProviderError(
        "Temperature must be between 0 and 2.",
      );
    }
  }

  const maxTokens =
    request.options?.maxTokens;

  if (maxTokens !== undefined) {
    if (
      !Number.isInteger(maxTokens) ||
      maxTokens <= 0
    ) {
      throw new AIProviderError(
        "maxTokens must be a positive integer.",
      );
    }
  }
}

// ─── Retry ────────────────────────────────────────────────────────────────────

function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function withRetry<T>(
  provider: GenerationProvider,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt += 1
  ) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === MAX_RETRIES) {
        break;
      }

      logger.warn(
        {
          provider,
          attempt,
          maxRetries: MAX_RETRIES,
        },
        "AI request failed — retrying.",
      );

      await sleep(
        RETRY_DELAY_MS * attempt,
      );
    }
  }

  throw lastError;
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

async function generateWithGroq(
  config: ProviderConfig,
  request: GenerationRequest,
): Promise<GenerationResponse> {
  try {
    const result: Awaited<
      ReturnType<typeof generateText>
    > = await withRetry(
      "groq",
      () =>
        generateText({
          model: groq(config.model),
          ...(request.system !== undefined
            ? { system: request.system }
            : {}),
          prompt: request.prompt,
          temperature:
            request.options?.temperature ??
            config.temperature,
          maxOutputTokens:
            request.options?.maxTokens ??
            config.maxTokens,
        }),
    );

    const text = result.text.trim();

    if (!text) {
      throw new AIProviderError(
        "Groq returned an empty response.",
      );
    }

    return {
      text,
      provider: "groq",
      model: config.model,
    };
  } catch (error) {
    if (error instanceof AIProviderError) {
      throw error;
    }

    throw new AIProviderError(
      "Groq generation failed.",
      error,
    );
  }
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function generateWithGemini(
  config: ProviderConfig,
  request: GenerationRequest,
): Promise<GenerationResponse> {
  const client = getGeminiClient();

  try {
    const response = await withRetry(
      "gemini",
      () =>
        client.models.generateContent({
          model: config.model,
          contents: request.prompt,
          config: {
            ...(request.system !== undefined
              ? { systemInstruction: request.system }
              : {}),
            temperature:
              request.options?.temperature ??
              config.temperature,
            maxOutputTokens:
              request.options?.maxTokens ??
              config.maxTokens,
          },
        }),
    );

    const text = response.text?.trim() ?? "";

    if (!text) {
      throw new AIProviderError(
        "Gemini returned an empty response.",
      );
    }

    return {
      text,
      provider: "gemini",
      model: config.model,
    };
  } catch (error) {
    if (error instanceof AIProviderError) {
      throw error;
    }

    throw new AIProviderError(
      "Gemini generation failed.",
      error,
    );
  }
}

// ─── Provider Dispatch ────────────────────────────────────────────────────────

async function generateWithProvider(
  config: ProviderConfig,
  request: GenerationRequest,
): Promise<GenerationResponse> {
  switch (config.provider) {
    case "groq":
      return generateWithGroq(
        config,
        request,
      );

    case "gemini":
      return generateWithGemini(
        config,
        request,
      );

    default:
      throw new AIProviderError(
        `Unsupported generation provider: ${String(
          config.provider,
        )}`,
      );
  }
}

// ─── Provider Resolution ──────────────────────────────────────────────────────

function resolveProviderChain(): ProviderConfig[] {
  const chain =
    modelConfig.fallbackChain();

  if (chain.length === 0) {
    throw new AIProviderError(
      "No generation providers are configured.",
    );
  }

  const seen =
    new Set<GenerationProvider>();

  const providers: ProviderConfig[] = [];

  for (const config of chain) {
    if (seen.has(config.provider)) {
      continue;
    }

    seen.add(config.provider);
    providers.push(config);
  }

  return providers;
}

// ─── Public Generation ─────────────────────────────────────────────────────────

export async function generate(
  request: GenerationRequest,
): Promise<GenerationResponse> {
  validateRequest(request);

  const startedAt = Date.now();
  const obsTrace = startTrace(
    "ai-generation",
    { mode: "generate" },
    ["generation"],
  );

  const providers =
    resolveProviderChain();

  let lastError: unknown;

  const failedProviders: string[] = [];

  for (const config of providers) {
    try {
      logger.debug(
        {
          provider: config.provider,
          model: config.model,
        },
        "Attempting AI generation.",
      );

      const response =
        await generateWithProvider(
          config,
          request,
        );

      logger.info(
        {
          provider: response.provider,
          model: response.model,
        },
        "AI generation succeeded.",
      );

      obsTrace.generation({
        name: "generate",
        model: response.model,
        provider: response.provider,
        inputText: request.prompt,
        outputText: response.text,
        latencyMs: Date.now() - startedAt,
        metadata: {
          attempts: failedProviders.length + 1,
          fallbacksUsed: failedProviders,
        },
      });

      obsTrace.end({ provider: response.provider });

      return response;
    } catch (error) {
      lastError = error;

      failedProviders.push(config.provider);

      logger.warn(
        {
          provider: config.provider,
          model: config.model,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        "AI provider failed — trying fallback.",
      );
    }
  }

  obsTrace.generation({
    name: "generate",
    inputText: request.prompt,
    latencyMs: Date.now() - startedAt,
    level: "ERROR",
    statusMessage:
      lastError instanceof Error
        ? lastError.message
        : "All providers failed",
    metadata: { failedProviders },
  });

  obsTrace.end({ failedProviders }, "All configured AI providers failed.");

  throw new AIProviderError(
    "All configured AI providers failed.",
    lastError,
  );
}

// ─── Explicit Provider ────────────────────────────────────────────────────────

export async function generateWith(
  provider: GenerationProvider,
  request: GenerationRequest,
): Promise<GenerationResponse> {
  validateRequest(request);

  const config =
    resolveProviderChain().find(
      (item) => item.provider === provider,
    );

  if (!config) {
    throw new AIProviderError(
      `Provider "${provider}" is not configured.`,
    );
  }

  return generateWithProvider(
    config,
    request,
  );
}

// ─── Streaming ────────────────────────────────────────────────────────────────

export interface StreamRequest {
  prompt: string;
  signal?: AbortSignal;
  options?: GenerationOptions;
}

export type TokenStream = AsyncGenerator<string>;

async function* streamWithGroq(
  config: ProviderConfig,
  request: StreamRequest,
): TokenStream {
  const result = streamText({
    model: groq(config.model),
    prompt: request.prompt,
    temperature:
      request.options?.temperature ??
      config.temperature,
    maxOutputTokens:
      request.options?.maxTokens ??
      config.maxTokens,
    ...(request.signal
      ? { abortSignal: request.signal }
      : {}),
  });

  for await (const delta of result.textStream) {
    yield delta;
  }
}

async function* streamWithGemini(
  config: ProviderConfig,
  request: StreamRequest,
): TokenStream {
  const client = getGeminiClient();

  const response = await client.models.generateContentStream({
    model: config.model,
    contents: request.prompt,
    config: {
      temperature:
        request.options?.temperature ??
        config.temperature,
      maxOutputTokens:
        request.options?.maxTokens ??
        config.maxTokens,
      ...(request.signal
        ? { abortSignal: request.signal }
        : {}),
    },
  });

  for await (const chunk of response) {
    const text = chunk.text;

    if (text) {
      yield text;
    }
  }
}

function streamWithProvider(
  config: ProviderConfig,
  request: StreamRequest,
): TokenStream {
  switch (config.provider) {
    case "groq":
      return streamWithGroq(config, request);

    case "gemini":
      return streamWithGemini(config, request);

    default:
      throw new AIProviderError(
        `Unsupported generation provider: ${String(config.provider)}`,
      );
  }
}

/**
 * Streams tokens from the first provider in the fallback chain.
 * A provider that fails BEFORE its first token falls through to the next;
 * once streaming has begun, failures propagate (the stream cannot restart).
 */
async function* stream(request: StreamRequest): TokenStream {
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    throw new AIProviderError(
      "Generation prompt cannot be empty.",
    );
  }

  const startedAt = Date.now();
  const obsTrace = startTrace(
    "ai-generation",
    { mode: "stream" },
    ["generation", "stream"],
  );

  const providers = resolveProviderChain();

  let lastError: unknown;

  let streamedChars = 0;
  let firstTokenMs: number | null = null;
  let usedProvider: GenerationProvider | null = null;

  for (const config of providers) {
    let started = false;

    try {
      for await (const token of streamWithProvider(config, request)) {
        if (firstTokenMs === null) {
          firstTokenMs = Date.now() - startedAt;
          usedProvider = config.provider;
        }

        started = true;
        streamedChars += token.length;

        yield token;
      }

      obsTrace.generation({
        name: "stream",
        model: config.model,
        provider: config.provider,
        inputText: request.prompt,
        latencyMs: Date.now() - startedAt,
        firstTokenMs: firstTokenMs ?? undefined,
        metadata: { streamedChars },
      });

      obsTrace.end({ provider: config.provider, firstTokenMs });

      return;
    } catch (error) {
      lastError = error;

      if (request.signal?.aborted) {
        obsTrace.generation({
          name: "stream",
          model: config.model,
          provider: config.provider,
          latencyMs: Date.now() - startedAt,
          firstTokenMs: firstTokenMs ?? undefined,
          metadata: { streamedChars, aborted: true },
        });

        obsTrace.end({ aborted: true, streamedChars }, "Client aborted stream.");

        throw error;
      }

      logger.warn(
        {
          provider: config.provider,
          model: config.model,
          started,
          error:
            error instanceof Error ? error.message : String(error),
        },
        started
          ? "AI provider stream failed mid-generation."
          : "AI provider stream failed before first token — trying fallback.",
      );

      if (started) {
        obsTrace.generation({
          name: "stream",
          model: config.model,
          provider: config.provider,
          latencyMs: Date.now() - startedAt,
          firstTokenMs: firstTokenMs ?? undefined,
          level: "ERROR",
          statusMessage: "Stream failed mid-answer",
          metadata: { streamedChars },
        });

        obsTrace.end(
          { provider: config.provider, streamedChars },
          "Generation stream failed mid-answer.",
        );

        throw new AIProviderError(
          "Generation stream failed mid-answer.",
          error,
        );
      }
    }
  }

  obsTrace.generation({
    name: "stream",
    inputText: request.prompt,
    latencyMs: Date.now() - startedAt,
    level: "ERROR",
    statusMessage:
      lastError instanceof Error
        ? lastError.message
        : "All providers failed",
  });

  obsTrace.end({}, "All configured AI providers failed.");

  throw new AIProviderError(
    "All configured AI providers failed.",
    lastError,
  );
}

// ─── Service Object ───────────────────────────────────────────────────────────

export const providerService = {
  generate,
  generateWith,
  stream,
} as const;
import pino from "pino";
import { env } from "../config/env.js";

const REDACTED_PATHS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "REDIS_PASSWORD",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.apiKey",
  "*.token",
  "*.password",
  "*.secret",
];

export const logger = pino({
  level: env.LOG_LEVEL,

  redact: {
    paths: REDACTED_PATHS,
    censor: "[REDACTED]",
  },

  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },

  formatters: {
    level(label) {
      return {
        level: label,
      };
    },

    bindings() {
      return {
        service: "elcara",
        env: env.NODE_ENV,
      };
    },
  },

  timestamp:
    env.NODE_ENV === "production"
      ? pino.stdTimeFunctions.isoTime
      : pino.stdTimeFunctions.epochTime,

  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname,service,env",
            messageFormat: "{msg}",
            errorProps: "stack,type,statusCode",
          },
        },
      }
    : {}),
});

export type LogContext = {
  docId?: string;
  sessionId?: string;
  requestId?: string;
  route?: string;
  provider?: string;
  durationMs?: number;
};

export function requestLogger(ctx: LogContext) {
  return logger.child(ctx);
}

export function assertNodeRuntime(routeName: string) {
  if (
    typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !==
    "undefined"
  ) {
    throw new Error(
      `[logger] ${routeName} imported pino logger in Edge Runtime. ` +
        `Add \`export const runtime = "nodejs"\` to this route.`,
    );
  }
}

export const log = {
  upload: {
    started: (
      ctx: LogContext & {
        fileName: string;
        sizeBytes: number;
      },
    ) =>
      requestLogger(ctx).info(
        {
          fileName: ctx.fileName,
          sizeBytes: ctx.sizeBytes,
        },
        "Upload started",
      ),

    success: (
      ctx: LogContext & {
        fileName: string;
        chunkCount: number;
      },
    ) =>
      requestLogger(ctx).info(
        {
          fileName: ctx.fileName,
          chunkCount: ctx.chunkCount,
        },
        "Upload complete",
      ),

    failed: (
      ctx: LogContext & {
        fileName: string;
      },
      err: unknown,
    ) =>
      requestLogger(ctx).error(
        {
          err,
          fileName: ctx.fileName,
        },
        "Upload failed",
      ),
  },

  retrieval: {
    started: (
      ctx: LogContext & {
        query: string;
        topK: number;
      },
    ) =>
      requestLogger(ctx).debug(
        {
          topK: ctx.topK,
        },
        "Retrieval started",
      ),

    complete: (
      ctx: LogContext & {
        durationMs: number;
        hits: number;
      },
    ) =>
      requestLogger(ctx).info(
        {
          durationMs: ctx.durationMs,
          hits: ctx.hits,
        },
        "Retrieval complete",
      ),
  },

  agent: {
    step: (
      ctx: LogContext & {
        round: number;
        tool: string;
      },
    ) =>
      requestLogger(ctx).debug(
        {
          round: ctx.round,
          tool: ctx.tool,
        },
        "Agent step",
      ),

    capped: (
      ctx: LogContext & {
        maxRounds: number;
      },
    ) =>
      requestLogger(ctx).warn(
        {
          maxRounds: ctx.maxRounds,
        },
        "Agent loop capped",
      ),

    finished: (
      ctx: LogContext & {
        rounds: number;
        durationMs: number;
      },
    ) =>
      requestLogger(ctx).info(
        {
          rounds: ctx.rounds,
          durationMs: ctx.durationMs,
        },
        "Agent finished",
      ),
  },
  // Add to src/lib/logger.ts log object:
session: {
  created : (ctx: { sid: string }) =>
    logger.info(ctx, "Session created"),
  rotated : (ctx: { sid: string }) =>
    logger.info(ctx, "Session rotated"),
},

  verify: {
    verified: (
      ctx: LogContext & {
        quote: string;
        page: number;
      },
    ) =>
      requestLogger(ctx).debug(
        {
          page: ctx.page,
        },
        "Quote verified",
      ),

    rejected: (
      ctx: LogContext & {
        quote: string;
        reason: string;
      },
    ) =>
      requestLogger(ctx).warn(
        {
          reason: ctx.reason,
        },
        "Quote rejected",
      ),
  },

  llm: {
    request: (
      ctx: LogContext & {
        model: string;
        provider: string;
      },
    ) =>
      requestLogger(ctx).debug(
        {
          model: ctx.model,
          provider: ctx.provider,
        },
        "LLM request",
      ),

    response: (
      ctx: LogContext & {
        durationMs: number;
        tokens?: number;
      },
    ) =>
      requestLogger(ctx).info(
        {
          durationMs: ctx.durationMs,
          tokens: ctx.tokens,
        },
        "LLM response",
      ),

    fallback: (
      ctx: LogContext & {
        from: string;
        to: string;
        reason: string;
      },
    ) =>
      requestLogger(ctx).warn(
        {
          from: ctx.from,
          to: ctx.to,
          reason: ctx.reason,
        },
        "LLM provider fallback triggered",
      ),

    failed: (ctx: LogContext, err: unknown) =>
      requestLogger(ctx).error(
        {
          err,
        },
        "LLM request failed",
      ),
  },
};
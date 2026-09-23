import "dotenv/config";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// 1. PROVIDER CONFIGURATION
// ─────────────────────────────────────────────────────────────

const ProviderSchema = {
  gemini: z.object({
    GOOGLE_GENERATIVE_AI_API_KEY: z
      .string()
      .min(1, "Gemini API key is required"),

    GEMINI_GENERATION_MODEL: z
      .string()
      .default("gemini-2.5-flash"),

    GEMINI_EMBEDDING_MODEL: z
      .string()
      .default("gemini-embedding-2"),

    GEMINI_MAX_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(8192),

    GEMINI_TEMPERATURE: z.coerce
      .number()
      .min(0)
      .max(2)
      .default(0.2),
  }),

  groq: z.object({
    GROQ_API_KEY: z
      .string()
      .min(1, "Groq API key is required"),

    GROQ_GENERATION_MODEL: z
      .string()
      .default("openai/gpt-oss-120b"),

    GROQ_MAX_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(8192),

    GROQ_TEMPERATURE: z.coerce
      .number()
      .min(0)
      .max(2)
      .default(0.2),
  }),
} as const;

// ─────────────────────────────────────────────────────────────
// 2. MODEL ROUTING
// ─────────────────────────────────────────────────────────────

const ModelRoutingSchema = z.object({
  GENERATION_PROVIDER: z
    .enum(["groq", "gemini"])
    .default("groq"),

  EMBEDDING_PROVIDER: z
    .enum(["gemini"])
    .default("gemini"),

  GENERATION_FALLBACK_CHAIN: z
    .string()
    .default("groq,gemini")
    .transform((value) =>
      value
        .split(",")
        .map((provider) => provider.trim())
        .filter(Boolean),
    ),
});

// ─────────────────────────────────────────────────────────────
// 3. INFRASTRUCTURE
// ─────────────────────────────────────────────────────────────

const InfraSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(8000),

  HOST: z
    .string()
    .default("0.0.0.0"),

  // Production Redis
  UPSTASH_REDIS_REST_URL: z
    .string()
    .url()
    .optional(),

  UPSTASH_REDIS_REST_TOKEN: z
    .string()
    .min(1)
    .optional(),

  // Local Redis
  REDIS_HOST: z
    .string()
    .default("127.0.0.1"),

  REDIS_PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(6379),

  REDIS_PASSWORD: z
    .string()
    .default("devpassword"),

  // Document storage
  BLOB_READ_WRITE_TOKEN: z
    .string()
    .min(1)
    .optional(),
});

// ─────────────────────────────────────────────────────────────
// 4. INGESTION / RETRIEVAL LIMITS
// ─────────────────────────────────────────────────────────────

const IngestionSchema = z.object({
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),

  EMBED_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(100),

  MAX_AGENT_ROUNDS: z.coerce
    .number()
    .int()
    .positive()
    .max(4)
    .default(4),

  RETRIEVAL_TOP_K: z.coerce
    .number()
    .int()
    .positive()
    .default(15),

  INGEST_MAX_DURATION: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
});

// ─────────────────────────────────────────────────────────────
// 5. COMPOSE + VALIDATE
// ─────────────────────────────────────────────────────────────

const EnvSchema = z
  .object({})
  .merge(ProviderSchema.gemini)
  .merge(ProviderSchema.groq)
  .merge(ModelRoutingSchema)
  .merge(InfraSchema)
  .merge(IngestionSchema)
  .superRefine((value, ctx) => {
    // Fail fast: production needs managed Redis + Blob credentials at boot,
    // not at first request.
    if (value.NODE_ENV === "production") {
      const requiredInProduction = [
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
        "BLOB_READ_WRITE_TOKEN",
      ] as const;

      for (const key of requiredInProduction) {
        if (!value[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when NODE_ENV=production.`,
          });
        }
      }
    }

    // Reject unknown providers at startup instead of at first request.
    for (const provider of value.GENERATION_FALLBACK_CHAIN) {
      if (provider !== "groq" && provider !== "gemini") {
        ctx.addIssue({
          code: "custom",
          path: ["GENERATION_FALLBACK_CHAIN"],
          message: `Unsupported generation provider: ${provider}.`,
        });
      }
    }
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:\n");

  for (const issue of parsed.error.issues) {
    console.error(
      `  ${issue.path.join(".")} — ${issue.message}`,
    );
  }

  throw new Error(
    "Environment validation failed. Fix the errors above.",
  );
}

export const env = parsed.data;

// ─────────────────────────────────────────────────────────────
// 6. PROVIDER TYPES
// ─────────────────────────────────────────────────────────────

export type Provider = keyof typeof ProviderSchema;

// ─────────────────────────────────────────────────────────────
// 7. PROVIDER CONFIG HELPERS
// ─────────────────────────────────────────────────────────────

function getGenerationConfig(provider: "groq" | "gemini") {
  switch (provider) {
    case "groq":
      return {
        provider: "groq" as const,
        apiKey: env.GROQ_API_KEY,
        model: env.GROQ_GENERATION_MODEL,
        maxTokens: env.GROQ_MAX_TOKENS,
        temperature: env.GROQ_TEMPERATURE,
      };

    case "gemini":
      return {
        provider: "gemini" as const,
        apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
        model: env.GEMINI_GENERATION_MODEL,
        maxTokens: env.GEMINI_MAX_TOKENS,
        temperature: env.GEMINI_TEMPERATURE,
      };
  }
}

export const modelConfig = {
  generation() {
    return getGenerationConfig(env.GENERATION_PROVIDER);
  },

  embedding() {
    return {
      provider: "gemini" as const,
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      model: env.GEMINI_EMBEDDING_MODEL,
    };
  },

  fallbackChain() {
    // Chain membership is validated at parse time by the env schema.
    return env.GENERATION_FALLBACK_CHAIN.map((provider) =>
      getGenerationConfig(provider as "groq" | "gemini"),
    );
  },
} as const;
import express from "express";

import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { sessionMiddleware } from "./lib/middleware.js";
import { corsMiddleware } from "./middleware/cors.js";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error-handler.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { createRateLimiter } from "./middleware/rate-limit.js";
import { requestLoggerMiddleware } from "./middleware/request-logger.js";

import chatRoutes from "./routes/chat.routes.js";
import compareRoutes from "./routes/compare.routes.js";
import documentRoutes from "./routes/document.routes.js";
import healthRoutes from "./routes/health.routes.js";
import uploadRoutes from "./routes/upload.routes.js";

export const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(requestIdMiddleware);
app.use(corsMiddleware);
app.use(sessionMiddleware);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(requestLoggerMiddleware);

// LLM-spending endpoints are rate-limited (fixed-window Redis counters,
// per-session with a per-IP ceiling). Read endpoints are not — they are
// cheap, and the anonymous session model makes auth-free throttling of
// reads more friction than protection.
const uploadLimiter = createRateLimiter({
  bucket: "upload",
  maxPerSession: env.RATE_LIMIT_UPLOAD_MAX,
  windowSec: env.RATE_LIMIT_UPLOAD_WINDOW_SEC,
});

const chatLimiter = createRateLimiter({
  bucket: "chat",
  maxPerSession: env.RATE_LIMIT_CHAT_MAX,
  windowSec: env.RATE_LIMIT_CHAT_WINDOW_SEC,
});

const compareLimiter = createRateLimiter({
  bucket: "compare",
  maxPerSession: env.RATE_LIMIT_COMPARE_MAX,
  windowSec: env.RATE_LIMIT_COMPARE_WINDOW_SEC,
});

app.use("/health", healthRoutes);
app.use("/api/upload", uploadLimiter, uploadRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/chat", chatLimiter, chatRoutes);
app.use("/api/compare", compareLimiter, compareRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

logger.info(
  {
    env: env.NODE_ENV,
    blobConfigured: Boolean(env.BLOB_READ_WRITE_TOKEN),
    trustProxy: true,
  },
  "App configured successfully",
);
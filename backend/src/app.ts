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
import { requestLoggerMiddleware } from "./middleware/request-logger.js";

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

app.use("/health", healthRoutes);
app.use("/api/upload", uploadRoutes);

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
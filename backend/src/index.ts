import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { flushObservability } from "./lib/observability.js";
import { wireProcessHandlers } from "./middleware/error-handler.js";
import { recoverInterruptedIngestions } from "./services/ingestion/ingest.service.js";
import { app } from "./app.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

wireProcessHandlers();

const server = app.listen(
  env.PORT,
  env.HOST,
  () => {
    logger.info(
      {
        port: env.PORT,
        host: env.HOST,
        env: env.NODE_ENV,
      },
      `Server running at http://${env.HOST}:${env.PORT}`,
    );
  },
);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    logger.fatal(
      { port: env.PORT },
      `Port ${env.PORT} is already in use. Exiting.`,
    );
  } else {
    logger.fatal(
      { err: error },
      "Unexpected server error. Exiting.",
    );
  }

  process.exit(1);
});

// The ingestion queue is in-memory, so documents stuck "queued"/"processing"
// from a previous process can never finish — mark them failed and clean up
// before traffic sees them. Runs after listen so a slow Redis scan cannot
// delay startup; recovery of a handful of keys takes milliseconds anyway.
void recoverInterruptedIngestions().catch((error) => {
  logger.error(
    { err: error },
    "Boot recovery of interrupted ingestions failed.",
  );
});

function shutdown(signal: string): void {
  logger.info(
    { signal },
    "Shutdown signal received, closing HTTP server...",
  );

  const forceExit = setTimeout(() => {
    logger.warn(
      { timeoutMs: SHUTDOWN_TIMEOUT_MS },
      "Graceful shutdown timed out. Forcing exit.",
    );

    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  forceExit.unref();

  server.close(async () => {
    logger.info("HTTP server closed gracefully.");

    // Flush queued observability data before the process dies.
    await flushObservability();

    clearTimeout(forceExit);
    process.exit(0);
  });

  server.closeAllConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

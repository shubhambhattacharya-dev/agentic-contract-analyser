import { Router } from "express";

import { store } from "../lib/store.js";
import { HttpStatus } from "../middleware/error-handler.js";

const router = Router();

// Liveness: is the process running? Never touches dependencies.
router.get("/", (_req, res) => {
  res.status(HttpStatus.OK).json({
    status: "ok",
    service: "elcara-backend",
    timestamp: new Date().toISOString(),
  });
});

// Readiness: can the application use its required dependencies?
router.get("/ready", async (_req, res, next) => {
  try {
    const health = await store.health();

    if (!health.redis) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: "unavailable",
        service: "elcara-backend",
        redis: false,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(HttpStatus.OK).json({
      status: "ok",
      service: "elcara-backend",
      redis: true,
      latencyMs: health.latencyMs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
import { Router } from "express";
import { z } from "zod";

import { requireSession } from "../middleware/session.middleware.js";
import { compareDocuments, CompareError } from "../services/comparison/compare.service.js";
import { HttpStatus } from "../middleware/error-handler.js";

const router = Router();

const CompareRequestSchema = z.object({
  documentIdA: z.string().uuid(),
  documentIdB: z.string().uuid(),
});

/**
 * POST /api/compare — clause-level comparison of two documents:
 * section-number alignment, numeric-aware severity, grounded summaries.
 */
router.post("/", requireSession, async (req, res, next) => {
  try {
    const parsed = CompareRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Provide documentIdA and documentIdB (UUIDs).",
        },
      });
      return;
    }

    const result = await compareDocuments({
      sessionId: req.sessionId,
      documentIdA: parsed.data.documentIdA,
      documentIdB: parsed.data.documentIdB,
    });

    res.status(HttpStatus.OK).json(result);
  } catch (error) {
    if (error instanceof CompareError) {
      const status = error.code === "EMPTY_DOCUMENT" ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.NOT_FOUND;

      res.status(status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    next(error);
  }
});

export default router;

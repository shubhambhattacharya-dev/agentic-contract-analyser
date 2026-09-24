import { Router } from "express";
import { z } from "zod";

import {
  deleteDocument,
  getDocument,
  getDocumentContent,
  listDocuments,
} from "../controllers/document.controller.js";
import { getDocumentStatusController } from "../controllers/ingest.controller.js";
import { requireSession } from "../middleware/session.middleware.js";
import { validateParams } from "../middleware/validate.js";

const router = Router();

export const docIdParams = z.object({
  docId: z.string().uuid(),
});

router.get("/", requireSession, listDocuments);

router.get(
  "/:docId/status",
  validateParams(docIdParams),
  getDocumentStatusController,
);

router.get(
  "/:docId",
  requireSession,
  validateParams(docIdParams),
  getDocument,
);

router.get(
  "/:docId/content",
  requireSession,
  validateParams(docIdParams),
  getDocumentContent,
);

router.delete(
  "/:docId",
  requireSession,
  validateParams(docIdParams),
  deleteDocument,
);

export default router;

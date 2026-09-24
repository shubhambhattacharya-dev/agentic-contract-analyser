import { Router } from "express";

import { uploadDocumentController } from "../controllers/upload.controller.js";
import {
  handleMulterError,
  uploadSingle,
} from "../middleware/upload.js";

const router = Router();

router.post(
  "/",
  uploadSingle,
  handleMulterError,
  uploadDocumentController,
);

export default router;

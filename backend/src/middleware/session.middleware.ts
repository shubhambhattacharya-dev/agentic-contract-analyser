import type { NextFunction, Request, Response } from "express";

import { parseSessionFromHeader } from "../lib/session.js";
import {
  AppError,
  HttpStatus,
} from "./error-handler.js";

/**
 * Enforces that the incoming request includes a valid session cookie.
 * If missing or malformed, rejects immediately with 401 Unauthorized.
 */
export function requireSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const existingSession = parseSessionFromHeader(
    req.headers.cookie ?? null,
  );

  if (existingSession) {
    req.sessionId = existingSession;
    next();
    return;
  }

  /*
   * First contact: the global sessionMiddleware already assigned a fresh
   * sessionId and issued the Set-Cookie — but this request's Cookie header
   * predates it. Trust the assigned session instead of rejecting the very
   * first request of a new browser session.
   */
  if (req.sessionId) {
    next();
    return;
  }

  throw new AppError(
    "Session is required.",
    HttpStatus.UNAUTHORIZED,
    "SESSION_REQUIRED",
  );
}

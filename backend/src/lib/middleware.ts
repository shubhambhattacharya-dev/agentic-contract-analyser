import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";
import {
  createSessionCookie,
  createSessionId,
  parseSessionFromHeader,
} from "./session.js";

declare global {
  namespace Express {
    interface Request {
      sessionId: string;
    }
  }
}

export function sessionMiddleware(
  req: Request,
  res: Response,
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

  const sessionId = createSessionId();

  req.sessionId = sessionId;

  res.setHeader(
    "Set-Cookie",
    createSessionCookie(
      sessionId,
      env.NODE_ENV === "production",
    ),
  );

  next();
}
import { randomUUID } from "node:crypto";
import type {
  NextFunction,
  Request,
  Response,
} from "express";

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_RESPONSE_HEADER = "X-Request-ID";

const SAFE_REQUEST_ID_RE = /^[\w.-]{1,128}$/;

function normalizeRequestIdHeader(
  value: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(value) ? value[0] : value;

  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();

  return SAFE_REQUEST_ID_RE.test(trimmed) ? trimmed : null;
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = normalizeRequestIdHeader(
    req.headers[REQUEST_ID_HEADER],
  );

  const requestId = incoming ?? randomUUID();

  req.requestId = requestId;

  res.setHeader(
    REQUEST_ID_RESPONSE_HEADER,
    requestId,
  );

  next();
}
import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { store } from "../lib/store.js";
import { RateLimitError } from "./error-handler.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixed-window rate limiter (Redis-backed)
// ─────────────────────────────────────────────────────────────────────────────
//
// Two counters run per request:
//
//   session counter — one anonymous cookie's budget (maxPerSession / window)
//   IP counter      — a ceiling shared by everything from one IP
//                     (maxPerSession × ipMultiplier)
//
// The IP ceiling exists because sessions are anonymous and trivially rotated
// (drop the cookie → fresh budget). Either counter exceeding its limit
// rejects with 429 + Retry-After. Counter keys carry the window index, so
// old windows expire on their own via TTL.

export interface RateLimiterOptions {
  /** Bucket name, namespaced into the Redis keys. */
  bucket: string;

  /** Max requests per session per window. */
  maxPerSession: number;

  /** Window length in seconds. */
  windowSec: number;

  /** Per-IP ceiling = maxPerSession × multiplier. Default 5. */
  ipMultiplier?: number;

  /**
   * Injectable counter for unit tests. Defaults to the real Redis counter.
   * Returns the request count inside the current window (1 on first hit).
   */
  counter?: (key: string, ttlSec: number) => Promise<number>;

  /** Default true: NODE_ENV=test bypasses the mounted limiters so the
   *  existing integration suites are not order-dependent. The limiter's own
   *  integration test opts back in with false. */
  skipInTest?: boolean;
}

const DEFAULT_IP_MULTIPLIER = 5;

export function createRateLimiter(
  options: RateLimiterOptions,
): RequestHandler {
  const {
    bucket,
    maxPerSession,
    windowSec,
    ipMultiplier = DEFAULT_IP_MULTIPLIER,
    counter = store.incrWithTtl.bind(store),
    skipInTest = true,
  } = options;

  const maxPerIp = maxPerSession * ipMultiplier;

  if (skipInTest && env.NODE_ENV === "test") {
    return (_req, _res, next) => next();
  }

  function windowIndex(): number {
    return Math.floor(Date.now() / (windowSec * 1000));
  }

  function secondsUntilWindowEnd(): number {
    const msPerWindow = windowSec * 1000;
    const windowEnd = (windowIndex() + 1) * msPerWindow;

    return Math.max(1, Math.ceil((windowEnd - Date.now()) / 1000));
  }

  function setRateLimitHeaders(
    res: Response,
    limit: number,
    remaining: number,
  ): void {
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, remaining)));
    res.setHeader("RateLimit-Reset", String(secondsUntilWindowEnd()));
  }

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const window = windowIndex();
      const sessionKey = `elcara:rl:${bucket}:sess:${req.sessionId}:${window}`;
      const ipKey = `elcara:rl:${bucket}:ip:${req.ip ?? "unknown"}:${window}`;

      const [sessionCount, ipCount] = await Promise.all([
        counter(sessionKey, windowSec + 60),
        counter(ipKey, windowSec + 60),
      ]);

      const sessionRemaining = maxPerSession - sessionCount;
      const ipRemaining = maxPerIp - ipCount;

      // The client-facing budget is its session budget.
      setRateLimitHeaders(res, maxPerSession, sessionRemaining);

      const sessionExceeded = sessionRemaining < 0;
      const ipExceeded = ipRemaining < 0;

      if (!sessionExceeded && !ipExceeded) {
        next();
        return;
      }

      const retryAfterSec = secondsUntilWindowEnd();

      logger.warn(
        {
          requestId: req.requestId,
          bucket,
          sessionId: req.sessionId,
          ip: req.ip,
          sessionCount,
          ipCount,
          exceeded: ipExceeded ? "ip" : "session",
        },
        "Rate limit exceeded.",
      );

      res.setHeader("Retry-After", String(retryAfterSec));

      next(new RateLimitError());
    } catch (error) {
      // Fail open: an unavailable Redis must not take the API down with it.
      // The cost of a missed rejection is smaller than the cost of a hard
      // outage — and the LLM providers have their own quotas upstream.
      logger.error(
        { err: error, bucket },
        "Rate limiter counter failed — allowing request through.",
      );

      next();
    }
  };
}

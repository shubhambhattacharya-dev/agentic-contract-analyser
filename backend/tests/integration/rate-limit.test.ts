import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { redis } from "../../src/lib/redis.js";
import { store } from "../../src/lib/store.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { createRateLimiter } from "../../src/middleware/rate-limit.js";

/**
 * Exercises the real Redis-backed counter through a mounted limiter
 * (skipInTest: false). Unlike the unit suite, this proves the INCR+TTL
 * window semantics against an actual Redis.
 */

const SESSION_A = "elcara_sid=11111111-1111-4111-8111-111111111111";
const SESSION_B = "elcara_sid=22222222-2222-4222-8222-222222222222";

function buildApp(maxPerSession: number, ipMultiplier = 5): Express {
  const app = express();

  // The real sessionMiddleware requires env wiring; the limiter only reads
  // req.sessionId / req.ip, so a minimal stand-in keeps the test scoped to
  // the limiter itself.
  app.use((req, _res, next) => {
    const cookie = req.headers.cookie ?? "";
    const match = /elcara_sid=([0-9a-f-]+)/i.exec(cookie);
    req.sessionId = match?.[1] ?? "anonymous";
    next();
  });

  app.use(
    "/limited",
    createRateLimiter({
      bucket: "integration-test",
      maxPerSession,
      windowSec: 60,
      ipMultiplier,
      skipInTest: false,
    }),
  );

  app.get("/limited", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Serialize AppError rejections (429) into the JSON error contract.
  app.use(errorHandler);

  return app;
}

describe("rate limiter against real Redis", () => {
  beforeEach(async () => {
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it("allows up to the limit then returns 429 with Retry-After", async () => {
    const app = buildApp(3);

    for (let index = 0; index < 3; index += 1) {
      const response = await request(app).get("/limited").set("Cookie", SESSION_A);
      expect(response.status).toBe(200);
      expect(response.headers["ratelimit-remaining"]).toBe(String(2 - index));
    }

    const blocked = await request(app).get("/limited").set("Cookie", SESSION_A);

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(60);
  });

  it("enforces the per-IP ceiling across rotating sessions", async () => {
    // 2 per session × multiplier 2 = 4 per IP before anything blocks.
    const app = buildApp(2, 2);

    const sessionCookies = [
      SESSION_A,
      SESSION_B,
      "elcara_sid=33333333-3333-4333-8333-333333333333",
      "elcara_sid=44444444-4444-4444-8444-444444444444",
    ];

    for (const cookie of sessionCookies) {
      const response = await request(app).get("/limited").set("Cookie", cookie);
      expect(response.status).toBe(200);
    }

    // Fresh session, same IP → the IP ceiling catches it.
    const blocked = await request(app)
      .get("/limited")
      .set("Cookie", "elcara_sid=55555555-5555-4555-8555-555555555555");

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("expires the window so counters reset (TTL semantics)", async () => {
    const app = buildApp(1);

    const first = await request(app).get("/limited").set("Cookie", SESSION_A);
    expect(first.status).toBe(200);

    const blocked = await request(app).get("/limited").set("Cookie", SESSION_A);
    expect(blocked.status).toBe(429);

    // Simulate window expiry by deleting the counter keys directly.
    const keys = await store.scanKeys("elcara:rl:integration-test:*");
    expect(keys.length).toBeGreaterThan(0);
    await store.del(...keys);

    const again = await request(app).get("/limited").set("Cookie", SESSION_A);
    expect(again.status).toBe(200);
  });
});

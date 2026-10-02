import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createRateLimiter } from "../../src/middleware/rate-limit.js";
import { errorHandler } from "../../src/middleware/error-handler.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map-backed fixed-window counter standing in for the Redis counter. */
function makeFakeCounter() {
  const counts = new Map<string, number>();

  const counter = async (key: string): Promise<number> => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts.get(key) as number;
  };

  return { counter, counts };
}

function buildApp(
  limiterOptions: Parameters<typeof createRateLimiter>[0],
  sessionId: string,
): Express {
  const app = express();

  // Stand-in for sessionMiddleware: fixed session id (or per-request unique
  // via header, to simulate cookie rotation).
  app.use((req, _res, next) => {
    req.sessionId = req.headers["x-test-session"] as string ?? sessionId;
    next();
  });

  app.use("/limited", createRateLimiter(limiterOptions));

  app.get("/limited", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Serialize AppError rejections (429) into the JSON error contract.
  app.use(errorHandler);

  return app;
}

const BASE_OPTIONS = {
  bucket: "test",
  maxPerSession: 2,
  windowSec: 60,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  it("allows requests under the session limit and sets RateLimit headers", async () => {
    const { counter } = makeFakeCounter();
    const app = buildApp(
      { ...BASE_OPTIONS, counter, skipInTest: false },
      "sess-a",
    );

    const first = await request(app).get("/limited");
    expect(first.status).toBe(200);
    expect(first.headers["ratelimit-limit"]).toBe("2");
    expect(first.headers["ratelimit-remaining"]).toBe("1");

    const second = await request(app).get("/limited");
    expect(second.status).toBe(200);
    expect(second.headers["ratelimit-remaining"]).toBe("0");
  });

  it("returns 429 with Retry-After once the session budget is exhausted", async () => {
    const { counter } = makeFakeCounter();
    const app = buildApp(
      { ...BASE_OPTIONS, counter, skipInTest: false },
      "sess-a",
    );

    await request(app).get("/limited");
    await request(app).get("/limited");

    const third = await request(app).get("/limited");
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("RATE_LIMITED");
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(third.headers["ratelimit-remaining"]) || 0).toBeLessThanOrEqual(0);
  });

  it("counts each session separately", async () => {
    const { counter } = makeFakeCounter();
    const app = buildApp(
      { ...BASE_OPTIONS, counter, skipInTest: false },
      "sess-a",
    );

    await request(app).get("/limited");
    await request(app).get("/limited");

    // A different session has its own budget.
    const other = await request(app)
      .get("/limited")
      .set("x-test-session", "sess-b");
    expect(other.status).toBe(200);
  });

  it("blocks at the per-IP ceiling even when sessions rotate", async () => {
    const { counter } = makeFakeCounter();
    const app = buildApp(
      {
        bucket: "test",
        maxPerSession: 2,
        windowSec: 60,
        ipMultiplier: 2,
        counter,
        skipInTest: false,
      },
      "rotating",
    );

    // Two fresh sessions each burn their full budget → 4 requests hit the
    // IP ceiling (2 × multiplier). Every request uses a unique session.
    let last;
    for (let index = 0; index < 4; index += 1) {
      last = await request(app)
        .get("/limited")
        .set("x-test-session", `sess-${index}`);
      expect(last.status).toBe(200);
    }

    // 5th request: fresh session, but the IP budget is gone.
    const blocked = await request(app)
      .get("/limited")
      .set("x-test-session", "sess-new");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("fails open when the counter is unavailable", async () => {
    const app = buildApp(
      {
        ...BASE_OPTIONS,
        counter: async () => {
          throw new Error("redis down");
        },
        skipInTest: false,
      },
      "sess-a",
    );

    const response = await request(app).get("/limited");
    expect(response.status).toBe(200);
  });

  it("skips entirely in NODE_ENV=test unless opted in", async () => {
    const counter = vi.fn().mockResolvedValue(1);
    const app = buildApp(
      { ...BASE_OPTIONS, counter, skipInTest: true },
      "sess-a",
    );

    for (let index = 0; index < 5; index += 1) {
      const response = await request(app).get("/limited");
      expect(response.status).toBe(200);
    }

    expect(counter).not.toHaveBeenCalled();
  });
});

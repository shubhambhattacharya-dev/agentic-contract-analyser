import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { logger } from "./logger.js";

export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  // In production the app uses Upstash REST; the local ioredis client must
  // never dial out (it would spam ECONNREFUSED against a nonexistent local
  // Redis). lazyConnect defers the connection until a command actually runs.
  lazyConnect: env.NODE_ENV === "production",
});

redis.on("connect", () => {
  logger.info(
    { host: env.REDIS_HOST, port: env.REDIS_PORT },
    "Redis connected",
  );
});

redis.on("error", (error) => {
  logger.error({ err: error }, "Redis error");
});

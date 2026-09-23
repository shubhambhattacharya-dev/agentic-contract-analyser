import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { logger } from "./logger.js";

export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
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
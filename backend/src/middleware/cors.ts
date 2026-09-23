// backend/src/middleware/cors.ts

import cors, { type CorsOptions } from "cors";

import { env } from "../config/env.js";

const PRODUCTION_ORIGINS: string[] = [
  "https://elcara.vercel.app",
  "https://elcara-git-main.vercel.app",
];

const DEVELOPMENT_ORIGINS: string[] = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const ALLOWED_ORIGINS =
  env.NODE_ENV === "production"
    ? PRODUCTION_ORIGINS
    : DEVELOPMENT_ORIGINS;

function validateOrigin(
  origin: string | undefined,
  callback: (
    error: Error | null,
    allow?: boolean,
  ) => void,
): void {
  if (!origin) {
    if (env.NODE_ENV === "production") {
      callback(
        new Error(
          "Requests without an Origin header are not allowed in production.",
        ),
      );
    } else {
      callback(null, true);
    }

    return;
  }

  if (ALLOWED_ORIGINS.includes(origin)) {
    callback(null, true);
    return;
  }

  callback(
    new Error(
      `CORS: Origin "${origin}" is not allowed.`,
    ),
  );
}

const corsOptions: CorsOptions = {
  origin: validateOrigin,

  credentials: true,

  methods: [
    "GET",
    "POST",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Request-ID",
  ],

  exposedHeaders: [
    "X-Request-ID",
  ],

  maxAge: 7200,

  optionsSuccessStatus: 204,
};

export const corsMiddleware = cors(corsOptions);
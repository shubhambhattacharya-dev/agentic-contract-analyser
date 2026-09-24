import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";
import { ZodError } from "zod";

import { logger } from "../lib/logger.js";

export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
    fields?: {
      path: string;
      message: string;
    }[];
  };
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR,
    code: string = "INTERNAL_ERROR",
    isOperational = true,
  ) {
    super(message);

    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }

  serialize(requestId?: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(
      `${resource} not found.`,
      HttpStatus.NOT_FOUND,
      "NOT_FOUND",
    );
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed.") {
    super(
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
      "VALIDATION_ERROR",
    );
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized.") {
    super(
      message,
      HttpStatus.UNAUTHORIZED,
      "UNAUTHORIZED",
    );
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(
      "Too many requests. Please try again later.",
      HttpStatus.TOO_MANY_REQUESTS,
      "RATE_LIMITED",
    );
  }
}

export function notFoundHandler(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(
    new NotFoundError(`Route ${req.method} ${req.originalUrl}`),
  );
}

function getRequestId(req: Request): string | undefined {
  // Prefer the normalized ID assigned by requestIdMiddleware (which also
  // generates one when the client did not send a safe value).
  if (req.requestId) {
    return req.requestId;
  }

  const header = req.headers["x-request-id"];

  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestId = getRequestId(req);

  if (error instanceof ZodError) {
    const fields = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));

    logger.warn(
      {
        requestId,
        fields,
      },
      "Request validation failed",
    );

    const response: ErrorResponse = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        ...(requestId ? { requestId } : {}),
        fields,
      },
    };

    res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(response);
    return;
  }

  if (error instanceof AppError && error.isOperational) {
    logger.warn(
      {
        requestId,
        code: error.code,
        statusCode: error.statusCode,
      },
      error.message,
    );

    res
      .status(error.statusCode)
      .json(error.serialize(requestId));

    return;
  }

  logger.error(
    {
      err: error,
      requestId,
    },
    "Unhandled server error",
  );

  const response: ErrorResponse = {
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      ...(requestId ? { requestId } : {}),
    },
  };

  res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(response);
};

export function wireProcessHandlers(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error(
      { err: reason },
      "Unhandled promise rejection",
    );

    process.exit(1);
  });

  process.on("uncaughtException", (error: Error) => {
    logger.fatal(
      { err: error },
      "Uncaught exception. Shutting down.",
    );

    process.exit(1);
  });
}
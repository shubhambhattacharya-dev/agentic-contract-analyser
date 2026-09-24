// Global Express request augmentations.
// Kept in one ambient file so every module sees the same request shape.

declare global {
  namespace Express {
    interface Request {
      /** Normalized correlation ID assigned by requestIdMiddleware. */
      requestId: string;
      /** Session ID associated with the request. */
      sessionId: string;
    }
  }
}

export {};

import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

export function validateBody<T extends ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(result.error);
      return;
    }

    req.body = result.data;
    next();
  };
}

export function validateParams<T extends ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      next(result.error);
      return;
    }

    req.params = result.data as Record<string, string>;
    next();
  };
}

export function validateQuery<T extends ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      next(result.error);
      return;
    }

    // Express 5 defines req.query as a getter-only accessor, so direct
    // assignment throws. The accessor is configurable, so redefine it as a
    // writable own property carrying the validated data.
    Object.defineProperty(req, "query", {
      value: result.data,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    next();
  };
}
import type { ErrorRequestHandler, NextFunction, Request, Response, Router } from "express";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Express 4 doesn't catch a rejected promise from an async route handler: the
 * request never gets an answer and, on Vercel, hangs until the function's
 * 30-second timeout. This wraps every route handler already registered on
 * `router` so a rejection goes to next(err) and reaches errorHandler below.
 * Call it once per router, after its routes are defined.
 */
export function catchAsyncErrors(router: Router): Router {
  for (const layer of router.stack) {
    for (const routeLayer of layer.route?.stack ?? []) {
      const handle = routeLayer.handle as Handler;
      // Error handlers (four parameters) are left alone; Express tells them
      // apart by arity, and the wrapper below has three.
      if (handle.length > 3) continue;
      routeLayer.handle = (req: Request, res: Response, next: NextFunction) => {
        try {
          return Promise.resolve(handle(req, res, next)).catch(next);
        } catch (err) {
          return next(err);
        }
      };
    }
  }
  return router;
}

/** Last stop for errors: log the cause, answer with a plain 500. The cause
 * stays in the logs, not the response. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "internal_error" });
};

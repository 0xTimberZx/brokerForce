import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { catchAsyncErrors, errorHandler } from "./asyncErrors.js";

async function serve(app: express.Express) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe("catchAsyncErrors", () => {
  it("turns a rejected async handler into a prompt 500 instead of a hang", async () => {
    const router = express.Router();
    router.get("/boom", async () => {
      throw new Error('password authentication failed for user "postgres"');
    });
    router.get("/ok", async (_req, res) => {
      res.json({ ok: true });
    });
    const app = express();
    app.use("/api", catchAsyncErrors(router));
    app.use(errorHandler);
    const { base, close } = await serve(app);
    const errLog = console.error;
    console.error = () => {};
    try {
      const boom = await fetch(`${base}/api/boom`, { signal: AbortSignal.timeout(2000) });
      expect(boom.status).toBe(500);
      const body = await boom.json();
      expect(body).toEqual({ error: "internal_error" }); // the cause stays in the logs
      const ok = await fetch(`${base}/api/ok`);
      expect(await ok.json()).toEqual({ ok: true });
    } finally {
      console.error = errLog;
      close();
    }
  });

  it("also catches a synchronous throw", async () => {
    const router = express.Router();
    router.get("/sync", () => {
      throw new Error("sync");
    });
    const app = express();
    app.use(catchAsyncErrors(router));
    app.use(errorHandler);
    const { base, close } = await serve(app);
    const errLog = console.error;
    console.error = () => {};
    try {
      expect((await fetch(`${base}/sync`)).status).toBe(500);
    } finally {
      console.error = errLog;
      close();
    }
  });
});

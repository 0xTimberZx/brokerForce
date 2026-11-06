import express from "express";
import { app } from "./app.js";

// Vercel serverless entry (spec 022, Phase 0). The web app calls the API at
// /api/* (apps/web/src/api/client.ts), and Vercel hands the function the
// original request path, so the app is mounted under /api. The bare mount
// behind it catches a request that arrives without the prefix.
const root = express();
root.disable("x-powered-by");
root.use("/api", app);
root.use(app);

export default root;

// Builds the terminal for Vercel using the Build Output API v3 (spec 022,
// Phase 0): the Vite web app as static files, and apps/api bundled into a
// single Node function served at /api/*. Run from the repo root:
//
//   node scripts/build-vercel.mjs
//
// The workspace packages export TypeScript source (main: src/index.ts), so
// the API is bundled with esbuild rather than shipped as-is.

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const OUT = ".vercel/output";
const FUNC = `${OUT}/functions/api.func`;

// Vercel's Portland region, nearest the Supabase database (us-west-2). The
// pipeline timeouts fixed in #45 showed what cross-country round trips cost.
const REGIONS = ["pdx1"];

rmSync(OUT, { recursive: true, force: true });

// 1. Web app -> static files.
execSync("npm run build --workspace=apps/web", { stdio: "inherit" });
cpSync("apps/web/dist", `${OUT}/static`, { recursive: true });

// 2. API -> one CommonJS bundle. pg-native is pg's optional native binding,
// loaded only on request; leaving it out keeps the pure-JS driver.
mkdirSync(FUNC, { recursive: true });
await build({
  entryPoints: ["apps/api/src/vercel.ts"],
  outfile: `${FUNC}/index.cjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["pg-native"],
  sourcemap: true, // index.cjs.map beside the bundle, for local debugging
  logLevel: "info",
  // vercel.ts has a default export; the Node launcher wants the handler itself.
  footer: { js: "module.exports = module.exports.default;" },
});
writeFileSync(
  `${FUNC}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.cjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      maxDuration: 30,
      regions: REGIONS,
    },
    null,
    2
  )
);

// 3. Routing: /api/* to the function, real files as they are, and every
// other path to index.html so client-side routes (/pairs/ETH/XRP, ...) load.
writeFileSync(
  `${OUT}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/api(?:/.*)?$", dest: "/api" },
        { handle: "filesystem" },
        { src: "^/(.*)$", dest: "/index.html" },
      ],
    },
    null,
    2
  )
);

console.log(`Vercel build output written to ${OUT}`);

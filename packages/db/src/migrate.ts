// Minimal migration runner -- runs every .sql file in migrations/ in filename
// order, inside a transaction each. No migration-tracking table yet (e.g.
// "which migrations have already run") since there's only one migration file
// so far -- add that bookkeeping when a second migration file shows up and
// re-running 001_init.sql unconditionally stops being safe.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

async function main() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found in", migrationsDir);
    return;
  }

  const pool = getPool();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    console.log(`Running migration: ${file}`);
    await pool.query(sql);
  }
  console.log(`Done. Ran ${files.length} migration file(s).`);
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());

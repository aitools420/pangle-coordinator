// Pangle coordinator DB backup — WAL-safe online snapshot + gzip + rotation.
// Uses better-sqlite3's online .backup() (already a project dependency; no sqlite3 CLI needed).
// Safe to run while the coordinator is live. Invoked by scripts/backup-db.sh.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, createReadStream, createWriteStream, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const src = process.env.DB_PATH || "./data/pangle.db";
const destDir = "./backups";
const keep = Number(process.env.KEEP || 14);

mkdirSync(destDir, { recursive: true });

if (!existsSync(src)) {
  console.log(`[backup-db] no DB at ${src} yet — nothing to back up (coordinator may not have run).`);
  process.exit(0);
}

const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-"); // e.g. 20260603-033400
const out = `${destDir}/pangle-${ts}.db`;

const db = new Database(src, { readonly: true, fileMustExist: true });
await db.backup(out); // online, consistent across the WAL
db.close();

await pipeline(createReadStream(out), createGzip(), createWriteStream(`${out}.gz`));
unlinkSync(out);
const sizeKb = Math.max(1, Math.round(statSync(`${out}.gz`).size / 1024));
console.log(`[backup-db] wrote ${out}.gz (${sizeKb} KB)`);

// Rotate: keep the newest `keep`, delete older.
const backups = readdirSync(destDir)
  .filter((f) => /^pangle-.*\.db\.gz$/.test(f))
  .map((f) => ({ f, m: statSync(`${destDir}/${f}`).mtimeMs }))
  .sort((a, b) => b.m - a.m);
for (const { f } of backups.slice(keep)) rmSync(`${destDir}/${f}`, { force: true });
console.log(`[backup-db] retained ${Math.min(backups.length, keep)} backup(s) (keep=${keep}).`);

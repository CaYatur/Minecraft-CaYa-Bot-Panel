import * as fs from "fs";
import * as path from "path";

// __dirname: server/src/config (dev, tsx) or server/dist/config (build) — repo root is 3 levels up either way.
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
// Packaged desktop builds set CAYA_DATA_DIR to a writable per-user folder (Program Files isn't writable).
export const DATA_DIR = process.env.CAYA_DATA_DIR || path.join(REPO_ROOT, "data");
export const LOGS_DIR = path.join(DATA_DIR, "logs");
export const CHAT_LOGS_DIR = path.join(LOGS_DIR, "chat");
export const SCHEMATICS_DIR = path.join(DATA_DIR, "schematics");
export const SCHEMATICS_FILES_DIR = path.join(SCHEMATICS_DIR, "files");
export const WEB_DIST_DIR = path.join(REPO_ROOT, "web", "dist");

for (const dir of [DATA_DIR, LOGS_DIR, CHAT_LOGS_DIR, SCHEMATICS_DIR, SCHEMATICS_FILES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

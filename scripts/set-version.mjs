#!/usr/bin/env node
/**
 * set-version.mjs <version>
 * Validates semver and writes package.json + workspaces.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const version = String(process.argv[2] || "")
  .trim()
  .replace(/^v/i, "")
  .replace(/\s+/g, "");

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Gecersiz surum. Ornek: 1.0.0 veya 1.2.3-beta.1");
  process.exit(1);
}

const files = ["package.json", "server/package.json", "web/package.json"];
for (const rel of files) {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) {
    console.warn("  atlandi (yok):", rel);
    continue;
  }
  const p = JSON.parse(fs.readFileSync(fp, "utf8"));
  p.version = version;
  fs.writeFileSync(fp, JSON.stringify(p, null, 2) + "\n");
  console.log("  " + rel + " -> " + version);
}

console.log("OK version=" + version);

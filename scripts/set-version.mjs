#!/usr/bin/env node
/**
 * set-version.mjs <version>
 * Validates semver and writes root package.json + every workspace package.json.
 * Workspace list is derived from root "workspaces" (supports globs like packages/*).
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

/** @param {string} pattern npm workspace pattern (dir or glob) */
function expandWorkspace(pattern) {
  const abs = path.join(root, pattern);
  // exact package dir
  if (fs.existsSync(path.join(abs, "package.json"))) {
    return [path.relative(root, abs).replace(/\\/g, "/")];
  }
  // simple glob: foo/* or packages/*
  if (pattern.includes("*")) {
    const base = pattern.replace(/\/?\*+$/, "");
    const baseAbs = path.join(root, base);
    if (!fs.existsSync(baseAbs) || !fs.statSync(baseAbs).isDirectory()) return [];
    return fs
      .readdirSync(baseAbs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(base, d.name).replace(/\\/g, "/"))
      .filter((rel) => fs.existsSync(path.join(root, rel, "package.json")));
  }
  return [];
}

function packageJsonPaths() {
  const rootPkgPath = path.join(root, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
  const workspaces = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : Array.isArray(rootPkg.workspaces?.packages)
      ? rootPkg.workspaces.packages
      : [];

  const rels = new Set(["package.json"]);
  for (const ws of workspaces) {
    for (const dir of expandWorkspace(String(ws))) {
      rels.add(path.join(dir, "package.json").replace(/\\/g, "/"));
    }
  }
  return [...rels];
}

const files = packageJsonPaths();
if (files.length <= 1) {
  console.warn("  Uyari: workspace package.json bulunamadi; sadece root yazildi.");
}

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

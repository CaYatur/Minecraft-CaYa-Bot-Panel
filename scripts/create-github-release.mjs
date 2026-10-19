#!/usr/bin/env node
/**
 * create-github-release.mjs <version>
 * Uploads the Setup exe and SHA256SUMS.txt from dist-electron/ to GitHub release v<version>.
 * Requires: gh CLI authenticated.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubAssetName, isReleaseAsset } from "./release-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const version = String(process.argv[2] || "")
  .trim()
  .replace(/^v/i, "");

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Kullanım: node scripts/create-github-release.mjs 1.0.0");
  process.exit(1);
}

const tag = `v${version}`;
const outDir = path.join(root, "dist-electron");
const assets = fs.existsSync(outDir)
  ? fs
      .readdirSync(outDir)
      .filter(isReleaseAsset)
      .map((f) => path.join(outDir, f))
  : [];

// GitHub renames assets with spaces or other special characters. Refuse to
// upload anything it would rename, and check SHA256SUMS.txt lists exactly the
// stored names, so the published checksum file matches the published assets.
const renamed = assets.map((a) => path.basename(a)).filter((name) => githubAssetName(name) !== name);
if (renamed.length) {
  console.error(`These assets would be renamed by GitHub: ${renamed.join(", ")}. Rebuild with the nsis artifactName from package.json.`);
  process.exit(1);
}
const sumsFile = path.join(outDir, "SHA256SUMS.txt");
if (assets.some((a) => /setup.*\.exe$/i.test(path.basename(a)))) {
  if (!fs.existsSync(sumsFile)) {
    console.error("SHA256SUMS.txt is missing; run node scripts/checksums.mjs first.");
    process.exit(1);
  }
  const listed = fs
    .readFileSync(sumsFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.replace(/^[0-9a-f]{64}\s+\*?/i, ""));
  const exes = assets.map((a) => path.basename(a)).filter((name) => /setup.*\.exe$/i.test(name));
  const unlisted = exes.filter((name) => !listed.includes(name));
  const stale = listed.filter((name) => !exes.includes(name));
  if (unlisted.length || stale.length) {
    console.error(`SHA256SUMS.txt does not match the Setup assets (missing: ${unlisted.join(", ") || "-"}; extra: ${stale.join(", ") || "-"}).`);
    process.exit(1);
  }
}

const notes = [
  `# Minecraft CaYa Bot Panel ${tag}`,
  "",
  "## Windows",
  "- **Setup (NSIS):** kurulum sihirbazı",
  "- **SHA256SUMS.txt:** kurulum dosyasının SHA256 özeti",
  "",
  "MIT License © CaYatur"
].join("\n");

const notesFile = path.join(root, "dist-electron", `_release-notes-${version}.md`);
fs.mkdirSync(path.dirname(notesFile), { recursive: true });
fs.writeFileSync(notesFile, notes, "utf8");

function run(args, opts = {}) {
  console.log(">", "gh", args.join(" "));
  const r = spawnSync("gh", args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    ...opts
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

const view = spawnSync("gh", ["release", "view", tag], {
  cwd: root,
  stdio: "pipe",
  shell: true
});
const exists = view.status === 0;

if (!exists) {
  const args = [
    "release",
    "create",
    tag,
    "--title",
    `Minecraft CaYa Bot Panel ${tag}`,
    "--notes-file",
    notesFile,
    ...assets
  ];
  const code = run(args);
  if (code !== 0) process.exit(code);
} else {
  console.log(`Release ${tag} zaten var — exe asset'leri güncelleniyor...`);
  if (assets.length) {
    const code = run(["release", "upload", tag, ...assets, "--clobber"]);
    if (code !== 0) process.exit(code);
  }
}

console.log(`OK: GitHub release ${tag}`);
if (assets.length) {
  for (const a of assets) console.log("  +", path.basename(a));
} else {
  console.warn("  Uyarı: dist-electron içinde .exe yok (sadece notes).");
}

/**
 * Static checks for the Windows package, runnable on any OS.
 *
 * - The release ships the NSIS Setup exe and a portable zip (plus SHA256SUMS.txt).
 *   No self-extracting "portable" exe: it unpacked ~44k files on every start.
 * - Bedrock data and the viewer's build-time textures are left out of the package.
 * - Native modules stay outside an asar archive so canvas/gl can load.
 * - Every bare module the compiled server requires is a production
 *   dependency of the root package (directly or transitively), so
 *   electron-builder copies it into the app. Dev-only modules would be
 *   missing at runtime in the installed app.
 * - When an unpacked build exists (dist-electron/win-unpacked), the
 *   viewer, Discord and canvas/gl files are checked inside it too.
 */
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { checksumLine, githubAssetName, isReleaseAsset } from "./release-assets.mjs";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
let failures = 0;
const ok = (name) => console.log(`  ok ${name}`);
const fail = (name, detail) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};
const check = (name, cond, detail) => (cond ? ok(name) : fail(name, detail));

console.log("build config");
const build = pkg.build ?? {};
const targets = (build.win?.target ?? []).map((t) => (typeof t === "string" ? t : t.target));
check("Windows targets are NSIS and zip", targets.length === 2 && targets.includes("nsis") && targets.includes("zip"), JSON.stringify(targets));
check("no self-extracting portable exe", !targets.includes("portable"));
check("no Linux or macOS targets", !build.linux && !build.mac);
const dist = String(pkg.scripts?.["dist:win"] ?? "");
check("dist:win builds NSIS and zip", /electron-builder --win nsis zip(\s|$)/.test(dist) && !/portable/.test(dist), dist);
const files = build.files ?? [];
const excluded = files.filter((f) => f.startsWith("!"));
check("bedrock version data is left out", excluded.some((f) => f.includes("minecraft-data/data/bedrock/{0,1")));
check("bedrock common data still ships", !excluded.some((f) => /bedrock\/(\*\*|common)/.test(f)));
check("viewer build-time textures are left out", excluded.some((f) => f.includes("prismarine-viewer/public/textures/*/{blocks")));
check("viewer entity textures still ship", !excluded.some((f) => /entity/.test(f)));
check("dist:win writes checksums", dist.includes("scripts/checksums.mjs"));
check("native modules are not packed into asar", build.asar === false || (build.asarUnpack ?? []).some((p) => /canvas|gl/.test(p)));
for (const need of ["electron/**/*", "server/dist/**/*", "web/dist/**/*"]) check(`files include ${need}`, (build.files ?? []).includes(need));
check("versions match", ["server", "web"].every((ws) => JSON.parse(fs.readFileSync(path.join(root, ws, "package.json"), "utf8")).version === pkg.version), pkg.version);

console.log("release assets");
const keep = ["Minecraft CaYa Bot Panel Setup 3.0.6.exe", "caya-bot-panel-3.0.8-Portable.zip", "SHA256SUMS.txt"];
const drop = ["Minecraft CaYa Bot Panel Setup 3.0.6.exe.blockmap", "builder-debug.yml", ".icon-ico", "win-unpacked", "builder-effective-config.yaml", "__uninstaller-nsis-caya.exe", "_release-notes-3.0.6.md"];
check("release uploads the Setup exe, the portable zip and SHA256SUMS.txt", keep.every(isReleaseAsset));
const portableName = String(build.win?.artifactName ?? "")
  .replace(/\$\{name\}/g, pkg.name)
  .replace(/\$\{version\}/g, pkg.version)
  .replace(/\$\{ext\}/g, "zip");
check("portable zip name is a release asset", isReleaseAsset(portableName) && githubAssetName(portableName) === portableName, portableName);
const artifactName = String(build.nsis?.artifactName ?? "");
const setupName = artifactName.replace(/\$\{name\}/g, pkg.name).replace(/\$\{version\}/g, pkg.version).replace(/\$\{ext\}/g, "exe");
check("nsis artifactName is set", artifactName.length > 0, "build.nsis.artifactName missing (default name has spaces)");
check("Setup exe name has no characters GitHub would rename", artifactName.length > 0 && !/\$\{(?!name\}|version\}|ext\})/.test(artifactName) && githubAssetName(setupName) === setupName, setupName);
check("Setup exe name is still picked up as a release asset", isReleaseAsset(setupName), setupName);
check("GitHub stores spaces as dots", githubAssetName("Minecraft CaYa Bot Panel Setup 3.0.6.exe") === "Minecraft.CaYa.Bot.Panel.Setup.3.0.6.exe");
check("SHA256SUMS.txt lists the stored asset name", checksumLine("a".repeat(64), "Minecraft CaYa Bot Panel Setup 3.0.6.exe") === `${"a".repeat(64)}  Minecraft.CaYa.Bot.Panel.Setup.3.0.6.exe`);
check("release skips build leftovers", drop.every((name) => !isReleaseAsset(name)), drop.filter(isReleaseAsset).join(", "));

console.log("production dependency closure");
const packages = lock.packages ?? {};
function resolveIn(fromDir, name) {
  // Walk up node_modules folders like Node does.
  let dir = fromDir;
  for (;;) {
    const key = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!dir) return null;
    const idx = dir.lastIndexOf("/node_modules/");
    dir = idx >= 0 ? dir.slice(0, idx) : "";
  }
}
const prod = new Set();
const queue = Object.keys(pkg.dependencies ?? {}).map((name) => resolveIn("", name)).filter(Boolean);
while (queue.length) {
  const key = queue.pop();
  if (prod.has(key)) continue;
  prod.add(key);
  let entry = packages[key];
  if (entry?.link && entry.resolved) entry = packages[entry.resolved] ?? entry;
  const deps = { ...(entry?.dependencies ?? {}), ...(entry?.optionalDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    const hit = resolveIn(key, name);
    if (hit) queue.push(hit);
  }
}
const prodNames = new Set([...prod].map((key) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)));
for (const name of ["canvas", "gl", "node-canvas-webgl", "prismarine-viewer", "discord.js", "prismarine-auth", "mineflayer", "express", "socket.io"]) {
  check(`${name} ships with the app`, prodNames.has(name));
}

console.log("server imports");
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), "electron"]);
const missing = new Set();
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "vendor") scan(full);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    const re = /(?:from\s+|require\(\s*|import\(\s*)["']([^"'./][^"']*)["']/g;
    for (const match of text.matchAll(re)) {
      const spec = match[1];
      if (builtins.has(spec) || builtins.has(spec.split("/")[0])) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!prodNames.has(name)) missing.add(`${name} (${path.relative(root, full)})`);
    }
  }
}
scan(path.join(root, "server", "src"));
check("every server import is a production dependency", missing.size === 0, [...missing].join(", "));

const unpacked = path.join(root, "dist-electron", "win-unpacked", "resources", "app");
if (fs.existsSync(unpacked)) {
  console.log("unpacked build");
  for (const rel of [
    "server/dist/index.js",
    "web/dist/index.html",
    "node_modules/prismarine-viewer/package.json",
    "node_modules/discord.js/package.json",
    "node_modules/canvas/build/Release/canvas.node",
    "node_modules/gl/build/Release/webgl.node",
    "node_modules/node-canvas-webgl/package.json",
    "node_modules/minecraft-data/minecraft-data/data/bedrock/common/protocolVersions.json",
    "node_modules/prismarine-viewer/public/textures/1.21.4.png",
    "node_modules/prismarine-viewer/public/blocksStates/1.21.4.json",
    "node_modules/prismarine-viewer/public/textures/1.21.4/entity"
  ]) {
    check(`package contains ${rel}`, fs.existsSync(path.join(unpacked, rel)));
  }
  for (const rel of ["node_modules/minecraft-data/minecraft-data/data/bedrock/1.21.0", "node_modules/prismarine-viewer/public/textures/1.21.4/blocks"]) {
    check(`package leaves out ${rel}`, !fs.existsSync(path.join(unpacked, rel)));
  }
} else {
  console.log("  skip unpacked build checks (dist-electron/win-unpacked not found)");
}

console.log(failures ? `\npackaging check FAILED (${failures})` : "\npackaging check passed");
process.exit(failures ? 1 : 0);

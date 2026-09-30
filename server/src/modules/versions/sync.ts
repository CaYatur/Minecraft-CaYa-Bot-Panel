import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PanelError } from "../../core/errors";
import { createLogger } from "../../utils/logger";

const MOJANG_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const NPM_LATEST = "https://registry.npmjs.org/mineflayer/latest";
const FETCH_MS = 8_000;
const CACHE_MS = 10 * 60_000;

const log = createLogger("versions");

export interface VersionSyncStatus {
  checkedAt: number;
  online: boolean;
  installedMineflayer: string;
  installedLatestMc: string;
  supportedCount: number;
  mojangLatestRelease: string | null;
  npmMineflayer: string | null;
  npmLatestMc: string | null;
  /** Versions the published mineflayer adds that this install does not have. */
  npmAdds: string[];
  offerInstall: boolean;
  waitingOnPrismarine: boolean;
  writable: boolean;
  restartRequired: boolean;
  error?: string;
}

let cache: VersionSyncStatus | null = null;
let inflight: Promise<VersionSyncStatus> | null = null;
let installing = false;

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function readInstalled(): { mineflayer: string; versions: string[] } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mf = require("mineflayer") as { testedVersions?: string[] };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("mineflayer/package.json") as { version?: string };
    const versions = Array.isArray(mf.testedVersions) ? mf.testedVersions.map(String) : [];
    return { mineflayer: String(pkg.version ?? "0.0.0"), versions };
  } catch {
    return { mineflayer: "0.0.0", versions: [] };
  }
}

function findRepoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          dependencies?: Record<string, string>;
          workspaces?: unknown;
        };
        if (pkg.dependencies?.mineflayer || pkg.workspaces) return dir;
      } catch {
        /* */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function installTarget(): { root: string; writable: boolean } | null {
  if (__dirname.includes("app.asar")) return null;
  const root = findRepoRoot();
  if (!root) return null;
  const modules = path.join(root, "node_modules");
  try {
    fs.accessSync(modules, fs.constants.W_OK);
    fs.accessSync(path.join(root, "package.json"), fs.constants.W_OK);
  } catch {
    return { root, writable: false };
  }
  return { root, writable: true };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

function parseTestedVersions(source: string): string[] {
  const m = source.match(/testedVersions\s*=\s*\[([^\]]*)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] || x[2]).filter(Boolean);
}

async function fetchRemote(): Promise<{
  online: boolean;
  mojangLatestRelease: string | null;
  npmMineflayer: string | null;
  npmVersions: string[];
  error?: string;
}> {
  let mojangLatestRelease: string | null = null;
  let npmMineflayer: string | null = null;
  let npmVersions: string[] = [];
  const errors: string[] = [];
  try {
    const raw = await fetchText(MOJANG_MANIFEST);
    const manifest = JSON.parse(raw) as { latest?: { release?: string } };
    mojangLatestRelease = manifest.latest?.release ?? null;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    const raw = await fetchText(NPM_LATEST);
    const meta = JSON.parse(raw) as { version?: string };
    npmMineflayer = meta.version ?? null;
    if (npmMineflayer) {
      const src = await fetchText(`https://unpkg.com/mineflayer@${npmMineflayer}/lib/version.js`);
      npmVersions = parseTestedVersions(src);
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  return {
    online: Boolean(mojangLatestRelease || npmMineflayer),
    mojangLatestRelease,
    npmMineflayer,
    npmVersions,
    error: errors.length && !mojangLatestRelease && !npmMineflayer ? errors[0] : undefined
  };
}

function buildStatus(restartRequired: boolean): Promise<VersionSyncStatus> {
  if (inflight) return inflight;
  inflight = (async () => {
    const installed = readInstalled();
    const target = installTarget();
    const remote = await fetchRemote();
    const installedSet = new Set(installed.versions);
    const npmAdds = remote.npmVersions.filter((v) => !installedSet.has(v));
    const newerPkg = Boolean(remote.npmMineflayer && cmpSemver(remote.npmMineflayer, installed.mineflayer) > 0);
    const mojangMissing = Boolean(
      remote.mojangLatestRelease && !installedSet.has(remote.mojangLatestRelease)
    );
    const mojangInNpm = Boolean(remote.mojangLatestRelease && remote.npmVersions.includes(remote.mojangLatestRelease));
    const offerInstall = Boolean(target?.writable && newerPkg && (npmAdds.length > 0 || (mojangMissing && mojangInNpm)));
    const waitingOnPrismarine = Boolean(mojangMissing && remote.npmVersions.length > 0 && !mojangInNpm && npmAdds.length === 0);
    const status: VersionSyncStatus = {
      checkedAt: Date.now(),
      online: remote.online,
      installedMineflayer: installed.mineflayer,
      installedLatestMc: installed.versions[installed.versions.length - 1] ?? "?",
      supportedCount: installed.versions.length,
      mojangLatestRelease: remote.mojangLatestRelease,
      npmMineflayer: remote.npmMineflayer,
      npmLatestMc: remote.npmVersions[remote.npmVersions.length - 1] ?? null,
      npmAdds,
      offerInstall,
      waitingOnPrismarine,
      writable: Boolean(target?.writable),
      restartRequired,
      error: remote.error
    };
    cache = status;
    return status;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function getVersionSyncStatus(force = false): Promise<VersionSyncStatus> {
  if (!force && cache && Date.now() - cache.checkedAt < CACHE_MS && !cache.restartRequired) return Promise.resolve(cache);
  return buildStatus(cache?.restartRequired ?? false);
}

function runNpmInstall(root: string, version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new PanelError("Refusing to install an unexpected mineflayer version.", 400);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ["install", `mineflayer@${version}`, "--save"], {
      cwd: root,
      shell: process.platform === "win32",
      windowsHide: true
    });
    let err = "";
    child.stderr?.on("data", (d) => {
      err += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim().slice(-500) || `npm install exited ${code}`));
    });
  });
}

/** User-approved local install of the published mineflayer. Needs a process restart to load. */
export async function installPublishedMineflayer(anyBotOnline: boolean): Promise<VersionSyncStatus> {
  if (installing) throw new PanelError("A protocol install is already running.", 409);
  if (anyBotOnline) throw new PanelError("BOTS_ONLINE", 409);
  const target = installTarget();
  if (!target?.writable) throw new PanelError("NOT_WRITABLE", 400);
  const status = await getVersionSyncStatus(true);
  if (!status.offerInstall || !status.npmMineflayer) {
    throw new PanelError("NOTHING_TO_INSTALL", 400);
  }
  installing = true;
  try {
    log.info("Installing mineflayer", status.npmMineflayer);
    await runNpmInstall(target.root, status.npmMineflayer);
    log.success("mineflayer installed — restart required", status.npmMineflayer);
    const next: VersionSyncStatus = { ...status, restartRequired: true, offerInstall: false, checkedAt: Date.now() };
    cache = next;
    return next;
  } finally {
    installing = false;
  }
}

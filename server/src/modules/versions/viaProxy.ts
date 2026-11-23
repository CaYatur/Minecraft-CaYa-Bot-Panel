import { spawn, spawnSync, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { DATA_DIR } from "../../config/paths";
import { createLogger } from "../../utils/logger";

/**
 * ViaProxy (ViaVersion + ViaBackwards + ViaRewind in one Java app) between a bot
 * and a server whose Minecraft version mineflayer does not speak yet (issue #34:
 * "can our bot join the newest version without ViaBackwards on the server?").
 *
 * The bot connects to 127.0.0.1:<port> with the newest version mineflayer knows;
 * ViaProxy connects to the real server with the server's version and translates.
 * Only offline-mode (cracked) servers work: ViaProxy cannot sign in to an
 * online-mode server for a Microsoft account the panel holds.
 */

export const VIAPROXY = {
  version: "3.4.14",
  url: "https://github.com/ViaVersion/ViaProxy/releases/download/v3.4.14/ViaProxy-3.4.14.jar",
  sha256: "2894bbfb2f4342f8fde887af6c689313efd5b0e46a8006775eea0e21e2948ab5",
  /** class file version 61 */
  minJava: 17,
  /** highest server version this ViaProxy build translates */
  maxServer: "26.3"
} as const;

export type ViaProxyMode = "auto" | "always" | "off";

const log = createLogger("viaproxy");
const ROOT = path.join(DATA_DIR, "viaproxy");
const IDLE_STOP_MS = 60_000;
const READY_TIMEOUT_MS = 45_000;

export function normalizeViaProxyMode(v: unknown): ViaProxyMode {
  return v === "always" || v === "off" ? v : "auto";
}

// ---- version support ----------------------------------------------------------

type McData = {
  postNettyVersionsByProtocolVersion?: { pc?: Record<string, Array<{ minecraftVersion: string; version: number }>> };
  versionsByMinecraftVersion?: { pc?: Record<string, { version: number }> };
};

let latestProtocol: number | null = null;
function newestProtocol(): number {
  if (latestProtocol != null) return latestProtocol;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mf = require("mineflayer") as { latestSupportedVersion?: string };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const md = require("minecraft-data") as McData;
    latestProtocol = md.versionsByMinecraftVersion?.pc?.[String(mf.latestSupportedVersion)]?.version ?? 0;
  } catch {
    latestProtocol = 0;
  }
  return latestProtocol;
}

/** The newest version mineflayer speaks; a proxied bot joins ViaProxy with it. */
export function newestClientVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return String((require("mineflayer") as { latestSupportedVersion?: string }).latestSupportedVersion ?? "1.21.4");
  } catch {
    return "1.21.4";
  }
}

/** Does the installed mineflayer speak this protocol number? */
export function mineflayerSpeaks(protocol: number): boolean {
  if (!Number.isInteger(protocol) || protocol <= 0) return true; // unknown: let mineflayer try
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const md = require("minecraft-data") as McData;
    const known = md.postNettyVersionsByProtocolVersion?.pc?.[String(protocol)];
    if (!known?.length) return false;
    return protocol <= newestProtocol();
  } catch {
    return true;
  }
}

/** Server list ping: protocol number and version name, or null when unreachable. */
export async function pingServer(host: string, port: number, timeoutMs = 6_000): Promise<{ protocol: number; name: string } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mc = require("minecraft-protocol") as { ping(opts: Record<string, unknown>): Promise<unknown> };
    const res = (await Promise.race([
      mc.ping({ host, port, closeTimeout: timeoutMs, noPongTimeout: timeoutMs }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ping timeout")), timeoutMs + 500))
    ])) as { version?: { protocol?: number; name?: string } };
    const protocol = Number(res?.version?.protocol);
    if (!Number.isFinite(protocol)) return null;
    return { protocol, name: String(res?.version?.name ?? "") };
  } catch {
    return null;
  }
}

// ---- java -----------------------------------------------------------------------

export interface JavaInfo {
  path: string;
  major: number;
}

export function parseJavaMajor(versionOutput: string): number {
  const m = versionOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  const first = Number(m[1]);
  return first === 1 ? Number(m[2] ?? 0) : first; // "1.8.0" → 8
}

function javaCandidates(): string[] {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const out: string[] = [];
  if (process.env.CAYA_JAVA) out.push(process.env.CAYA_JAVA);
  if (process.env.JAVA_HOME) out.push(path.join(process.env.JAVA_HOME, "bin", exe));
  const roots =
    process.platform === "win32"
      ? ["Eclipse Adoptium", "Java", "Microsoft", "Zulu", "BellSoft", "Amazon Corretto", "Semeru"].flatMap((v) =>
          [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((p) => path.join(p!, v))
        )
      : process.platform === "darwin"
        ? ["/Library/Java/JavaVirtualMachines"]
        : ["/usr/lib/jvm"];
  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) {
        const home = process.platform === "darwin" ? path.join(root, name, "Contents", "Home") : path.join(root, name);
        out.push(path.join(home, "bin", exe));
      }
    } catch {
      /* not installed */
    }
  }
  out.push("java"); // PATH
  return out;
}

let javaCache: { at: number; info: JavaInfo | null } | null = null;
/** Newest Java 17+ on this machine, or null. */
export function findJava(): JavaInfo | null {
  if (javaCache && Date.now() - javaCache.at < 60_000) return javaCache.info;
  let best: JavaInfo | null = null;
  for (const candidate of javaCandidates()) {
    if (candidate !== "java" && !fs.existsSync(candidate)) continue;
    try {
      const r = spawnSync(candidate, ["-version"], { encoding: "utf8", timeout: 8_000, windowsHide: true });
      const major = parseJavaMajor(`${r.stderr ?? ""}${r.stdout ?? ""}`);
      if (major >= VIAPROXY.minJava && (!best || major > best.major)) best = { path: candidate, major };
    } catch {
      /* next */
    }
  }
  javaCache = { at: Date.now(), info: best };
  return best;
}

// ---- jar ------------------------------------------------------------------------

export interface JarRelease {
  version: string;
  url: string;
  sha256: string;
}

const PINNED: JarRelease = { version: VIAPROXY.version, url: VIAPROXY.url, sha256: VIAPROXY.sha256 };
const RELEASES_API = "https://api.github.com/repos/ViaVersion/ViaProxy/releases/latest";
const UPDATE_CHECK_MS = 12 * 60 * 60_000;

/** "3.4.14" vs "3.4.2": numeric compare, missing parts are 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The Java 17+ jar of a GitHub release, with the SHA-256 GitHub publishes for it.
 * Exported for unit tests. Null when the release has no such asset or no digest.
 */
export function pickReleaseJar(release: unknown): JarRelease | null {
  const r = release as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }> };
  if (!r || r.draft || r.prerelease || typeof r.tag_name !== "string") return null;
  const version = r.tag_name.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const asset = (r.assets ?? []).find((a) => a.name === `ViaProxy-${version}.jar`);
  const digest = /^sha256:([0-9a-f]{64})$/.exec(String(asset?.digest ?? ""))?.[1];
  if (!asset?.browser_download_url || !digest) return null;
  if (!asset.browser_download_url.startsWith("https://github.com/ViaVersion/ViaProxy/releases/download/")) return null;
  return { version, url: asset.browser_download_url, sha256: digest };
}

/**
 * Newest ViaProxy release (checked at most every 12 h, cached on disk), so a new
 * Minecraft version works once ViaProxy supports it, without a new panel build.
 * CAYA_VIAPROXY_AUTO_UPDATE=off keeps the pinned build.
 */
async function newestRelease(): Promise<JarRelease> {
  if (/^(0|off|false)$/i.test(process.env.CAYA_VIAPROXY_AUTO_UPDATE ?? "")) return PINNED;
  const cacheFile = path.join(ROOT, "latest.json");
  let cached: { checkedAt: number; release: JarRelease | null } | null = null;
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {
    cached = null;
  }
  let latest = cached?.release ?? null;
  if (!cached || Date.now() - cached.checkedAt > UPDATE_CHECK_MS) {
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "caya-bot-panel" },
        signal: AbortSignal.timeout(8_000)
      });
      if (res.ok) latest = pickReleaseJar(await res.json());
      fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), release: latest }));
    } catch {
      /* offline: use what we have */
    }
  }
  return latest && compareVersions(latest.version, PINNED.version) > 0 ? latest : PINNED;
}

async function downloadJar(rel: JarRelease): Promise<string> {
  const jar = path.join(ROOT, `ViaProxy-${rel.version}.jar`);
  if (fs.existsSync(jar) && sha256File(jar) === rel.sha256) return jar;
  log.info(`Downloading ViaProxy ${rel.version} (~47 MB, once)`);
  const res = await fetch(rel.url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`ViaProxy download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sum = createHash("sha256").update(buf).digest("hex");
  if (sum !== rel.sha256) throw new Error("ViaProxy download failed: checksum mismatch");
  const tmp = `${jar}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, jar);
  log.success(`ViaProxy ${rel.version} ready`);
  return jar;
}

let jarPromise: Promise<{ path: string; version: string }> | null = null;
let jarCheckedAt = 0;
/** Newest verified ViaProxy jar; falls back to the pinned build if the update fails. */
export function ensureViaProxyJar(): Promise<{ path: string; version: string }> {
  if (jarPromise && Date.now() - jarCheckedAt < UPDATE_CHECK_MS) return jarPromise;
  jarCheckedAt = Date.now();
  jarPromise = (async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    const want = await newestRelease();
    if (want.version !== PINNED.version) {
      try {
        return { path: await downloadJar(want), version: want.version };
      } catch (err) {
        log.warn(`ViaProxy ${want.version} could not be used, staying on ${PINNED.version}`, err instanceof Error ? err.message : String(err));
      }
    }
    return { path: await downloadJar(PINNED), version: PINNED.version };
  })();
  jarPromise.catch(() => {
    jarPromise = null; // allow a retry later
  });
  return jarPromise;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ---- processes ------------------------------------------------------------------

interface ProxyProc {
  key: string;
  port: number;
  child: ChildProcess | null;
  dead: boolean;
  users: number;
  ready: Promise<void>;
  idleTimer: NodeJS.Timeout | null;
  tail: string[];
}

const procs = new Map<string, ProxyProc>();

export interface ProxyLease {
  host: string;
  port: number;
  release(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1_000, () => done(false));
  });
}

function startProc(key: string, targetHost: string, targetPort: number): ProxyProc {
  const proc: ProxyProc = { key, port: 0, child: null, dead: false, users: 0, ready: Promise.resolve(), idleTimer: null, tail: [] };
  const fail = (msg: string): never => {
    proc.dead = true;
    if (procs.get(key) === proc) procs.delete(key);
    throw new Error(msg);
  };
  proc.ready = (async () => {
    const java = findJava();
    if (!java) {
      fail(`ViaProxy needs Java ${VIAPROXY.minJava} or newer. Install a Java runtime (for example Eclipse Temurin) or set CAYA_JAVA to java's path.`);
      return;
    }
    let jar: { path: string; version: string };
    try {
      jar = await ensureViaProxyJar();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    if (proc.dead) return; // stopped while downloading
    proc.port = await freePort();
    // each process gets its own folder: ViaProxy locks its log and config files
    const cwd = path.join(ROOT, "run", key.replace(/[^A-Za-z0-9.-]/g, "_"));
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(
      java.path,
      ["-Xmx512M", "-jar", jar.path, "cli", "--bind-address", `127.0.0.1:${proc.port}`, "--target-address", `${targetHost}:${targetPort}`, "--auth-method", "NONE", "--log-ips", "false"],
      { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    proc.child = child;
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        // eslint-disable-next-line no-control-regex
        const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!clean) continue;
        proc.tail.push(clean);
        if (proc.tail.length > 40) proc.tail.shift();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      proc.dead = true;
      if (procs.get(key) === proc) procs.delete(key);
      if (proc.users > 0) log.warn(`ViaProxy for ${key} stopped (exit ${code})`);
    });
    log.info(`Starting ViaProxy ${jar.version} for ${key} on 127.0.0.1:${proc.port} (Java ${java.major})`);
    const until = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < until && !proc.dead) {
      if (await canConnect(proc.port)) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    const why = proc.tail.filter((l) => /error|exception/i.test(l)).slice(-2).join(" | ");
    killProc(proc);
    fail(`ViaProxy did not start${why ? `: ${why}` : ""}`);
  })();
  proc.ready.catch(() => {
    /* reported to whoever awaits it */
  });
  return proc;
}

function killProc(p: ProxyProc) {
  p.dead = true;
  try {
    p.child?.kill();
  } catch {
    /* */
  }
}

/** One ViaProxy per target server, shared by every bot on it. */
export async function acquireViaProxy(targetHost: string, targetPort: number): Promise<ProxyLease> {
  const key = `${targetHost.toLowerCase()}:${targetPort}`;
  let p = procs.get(key);
  if (!p || p.dead) {
    // registered before any await, so bots starting together share one process
    p = startProc(key, targetHost, targetPort);
    procs.set(key, p);
  }
  if (p.idleTimer) {
    clearTimeout(p.idleTimer);
    p.idleTimer = null;
  }
  p.users++;
  try {
    await p.ready;
  } catch (err) {
    p.users--;
    throw err;
  }
  const proc = p;
  let released = false;
  return {
    host: "127.0.0.1",
    port: proc.port,
    release() {
      if (released) return;
      released = true;
      proc.users = Math.max(0, proc.users - 1);
      if (proc.users === 0 && !proc.idleTimer) {
        proc.idleTimer = setTimeout(() => {
          proc.idleTimer = null;
          if (proc.users === 0) killProc(proc);
        }, IDLE_STOP_MS);
        proc.idleTimer.unref?.();
      }
    }
  };
}

export function stopAllViaProxies(): void {
  for (const p of procs.values()) killProc(p);
  procs.clear();
}

process.once("exit", stopAllViaProxies);

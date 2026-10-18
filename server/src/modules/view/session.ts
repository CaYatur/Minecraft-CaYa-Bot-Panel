import * as http from "http";
import * as os from "os";
import { createRequire } from "module";
import type { Bot } from "mineflayer";
import { createLogger } from "../../utils/logger";
import { describeScene, inViewCone, type ScenePoint } from "./describe";
import { createHeadlessCanvas, releaseRenderer, type HeadlessSurface } from "./headlessCanvas";

const nodeRequire = createRequire(__filename);

const log = createLogger("viewer");
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;

interface LiveSession {
  port: number;
  close: () => void;
  lastSeen: number;
  bot: Bot;
}

const sessions = new Map<string, LiveSession>();
/** Starts in progress, so two clicks (or panel + MCP) cannot open two ports for one bot. */
const starting = new Map<string, Promise<StartResult>>();

type StartResult = { ok: true; url: string; port: number } | { ok: false; code: string; message: string };

/** The 3D viewer renders on the CPU; keep it off weak or busy machines. */
export const VIEWER_MIN_FREE_MB = 512;

export function maxViewers(cpuCount = os.cpus().length): number {
  return Math.max(1, Math.min(3, Math.floor(cpuCount / 2)));
}

export function viewerResourceCheck(
  input: { freeMb?: number; cpuCount?: number; running?: number; replacing?: boolean } = {}
): { ok: true } | { ok: false; code: string; message: string } {
  const freeMb = input.freeMb ?? Math.round(os.freemem() / 1024 / 1024);
  const cpuCount = input.cpuCount ?? os.cpus().length;
  const running = (input.running ?? sessions.size) - (input.replacing ? 1 : 0);
  if (freeMb < VIEWER_MIN_FREE_MB) {
    return {
      ok: false,
      code: "viewer.memory",
      message: `Not enough free memory for the 3D view (${freeMb} MB free, ${VIEWER_MIN_FREE_MB} MB needed). The text POV description still works.`
    };
  }
  const cap = maxViewers(cpuCount);
  if (running >= cap) {
    return {
      ok: false,
      code: "viewer.limit",
      message: `Only ${cap} 3D view${cap === 1 ? "" : "s"} can run at once on this machine. Close another bot view first.`
    };
  }
  return { ok: true };
}

/** Closes the view when the bot it was opened for is gone (stop, kick, reconnect). */
export function stopViewIfStale(botId: string, currentBot: Bot | null | undefined): void {
  const row = sessions.get(botId);
  if (row && row.bot !== currentBot) void stopView(botId);
}

export function viewStatus(botId: string): { running: boolean; url: string | null; port: number | null } {
  const row = sessions.get(botId);
  if (!row) return { running: false, url: null, port: null };
  return { running: true, url: `http://127.0.0.1:${row.port}`, port: row.port };
}

export function touchView(botId: string): void {
  const row = sessions.get(botId);
  if (row) row.lastSeen = Date.now();
}

export async function stopView(botId: string): Promise<void> {
  const row = sessions.get(botId);
  if (!row) return;
  sessions.delete(botId);
  try {
    row.close();
  } catch {
    /* already closed */
  }
}

export async function stopAllViews(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopView(id)));
}

setInterval(() => {
  const now = Date.now();
  for (const [id, row] of sessions) {
    if (now - row.lastSeen > 20_000) void stopView(id);
  }
}, 5_000).unref?.();

/**
 * One local page per bot. prismarine-viewer is optional; without it the panel
 * explains that the 3D view is unavailable instead of opening a port.
 */
export function startView(botId: string, bot: Bot, version: string): Promise<StartResult> {
  const inFlight = starting.get(botId);
  if (inFlight) return inFlight;
  const job = startViewNow(botId, bot, version).finally(() => starting.delete(botId));
  starting.set(botId, job);
  return job;
}

async function startViewNow(botId: string, bot: Bot, version: string): Promise<StartResult> {
  if (!version) return { ok: false, code: "viewer.version", message: "This bot has no Minecraft version yet." };
  const existing = sessions.get(botId);
  if (existing && existing.bot === bot) {
    existing.lastSeen = Date.now();
    return { ok: true, url: `http://127.0.0.1:${existing.port}`, port: existing.port };
  }
  const resources = viewerResourceCheck({ replacing: Boolean(existing) });
  if (!resources.ok) return resources;
  await stopView(botId);
  let viewer: ((bot: Bot, options: { port: number; firstPerson: boolean }) => void) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = nodeRequire("prismarine-viewer");
    viewer = mod.mineflayer ?? mod.default?.mineflayer;
  } catch {
    viewer = undefined;
  }
  if (!viewer) {
    return {
      ok: false,
      code: "viewer.unavailable",
      message: "The built-in 3D viewer failed to load. The text POV description still works."
    };
  }
  const port = await freePort();
  let server: http.Server | undefined;
  try {
    await runWithLocalViewerServer(() => {
      viewer!(bot, { port, firstPerson: false });
    }, (created) => {
      server = created;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Viewer failed to start", message);
    try {
      server?.close();
    } catch {
      /* not listening */
    }
    return { ok: false, code: "viewer.version", message: `This Minecraft version cannot be shown in the 3D viewer (${version}). ${message}` };
  }
  const viewerApi = (bot as { viewer?: { close?: () => void } }).viewer;
  sessions.set(botId, {
    port,
    bot,
    lastSeen: Date.now(),
    close: () => {
      try {
        viewerApi?.close?.();
      } catch {
        /* already closed */
      }
      try {
        server?.close();
      } catch {
        /* already closed */
      }
    }
  });
  log.info(`Viewer started for ${botId} on 127.0.0.1:${port}`);
  return { ok: true, url: `http://127.0.0.1:${port}`, port };
}

export function describeBot(bot: Bot, input: { yaw?: number; pitch?: number; fov?: number; radius?: number; applyLook?: boolean }): ReturnType<typeof describeScene> {
  const fov = Math.min(140, Math.max(20, input.fov ?? 70));
  const radius = Math.min(16, Math.max(4, Math.round(input.radius ?? 8)));
  const pos = bot.entity.position;
  const origin = { x: pos.x, y: pos.y + 1.6, z: pos.z };
  let yaw = input.yaw ?? bot.entity.yaw;
  let pitch = input.pitch ?? bot.entity.pitch;
  if (input.applyLook) {
    void bot.look(yaw, pitch, true);
  }
  const blocks: ScenePoint[] = [];
  const step = radius > 10 ? 2 : 1;
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dy = -Math.min(4, radius); dy <= Math.min(4, radius); dy += step) {
      for (let dz = -radius; dz <= radius; dz += step) {
        const point = { x: Math.floor(pos.x + dx), y: Math.floor(pos.y + dy), z: Math.floor(pos.z + dz) };
        if (!inViewCone(origin, yaw, pitch, fov, point)) continue;
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (!block || block.name === "air" || block.name === "cave_air") continue;
        blocks.push({ name: block.name, ...point, kind: "block" });
        if (blocks.length > 400) break;
      }
    }
  }
  const entities: ScenePoint[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position || entity === bot.entity) continue;
    const point = { x: entity.position.x, y: entity.position.y, z: entity.position.z };
    if (Math.hypot(point.x - pos.x, point.y - pos.y, point.z - pos.z) > radius + 8) continue;
    const name = String(entity.name ?? entity.displayName ?? "entity");
    const username = (entity as { username?: string }).username;
    const kind = username ? "player" : entity.name === "item" ? "item" : "mob";
    entities.push({ name: username || name, ...point, kind, health: (entity as { health?: number }).health });
  }
  let crosshair: { type: "block" | "entity" | "none"; name?: string; distance?: number } = { type: "none" };
  try {
    const cursor = bot.blockAtCursor(radius);
    if (cursor) {
      const distance = cursor.position.distanceTo(pos);
      crosshair = { type: "block", name: cursor.name, distance: Math.round(distance * 10) / 10 };
    }
  } catch {
    /* cursor can throw before chunks arrive */
  }
  return describeScene({
    origin,
    yaw,
    pitch,
    fov,
    blocks,
    entities,
    crosshair,
    light: (bot as unknown as { light?: number }).light ?? null,
    time: bot.time?.timeOfDay ?? null,
    weather: bot.thunderState > 0 ? "thunder" : bot.isRaining ? "rain" : "clear"
  });
}

let shotChain: Promise<unknown> = Promise.resolve();

export function renderSnapshot(bot: Bot, input: { width?: number; height?: number; viewDistance?: number; yaw?: number; pitch?: number }): Promise<{ ok: true; mimeType: string; base64: string; width: number; height: number } | { ok: false; code: string; message: string }> {
  const run = shotChain.then(() => renderSnapshotNow(bot, input), () => renderSnapshotNow(bot, input));
  shotChain = run.then(() => undefined, () => undefined);
  return run;
}

async function renderSnapshotNow(bot: Bot, input: { width?: number; height?: number; viewDistance?: number; yaw?: number; pitch?: number }): Promise<{ ok: true; mimeType: string; base64: string; width: number; height: number } | { ok: false; code: string; message: string }> {
  const width = Math.min(MAX_WIDTH, Math.max(160, Math.round(input.width ?? 640)));
  const height = Math.min(MAX_HEIGHT, Math.max(120, Math.round(input.height ?? 360)));
  const viewDistance = Math.min(6, Math.max(2, Math.round(input.viewDistance ?? 3)));
  if (!bot.entity?.position || !bot.world) {
    return { ok: false, code: "viewer.offline", message: "The bot is not in a world yet, so no POV frame was rendered." };
  }
  let canvas: HeadlessSurface | undefined;
  let renderer: { dispose(): void; render(scene: unknown, camera: unknown): void; setSize(w: number, h: number, updateStyle: boolean): void } | undefined;
  let worldView: { init(pos: unknown): Promise<void>; removeListenersFromBot?(bot: Bot): void } | undefined;
  let workers: { terminate(): Promise<number> }[] = [];
  const hadWindow = Object.prototype.hasOwnProperty.call(global, "window");
  try {
    const THREE = nodeRequire("three") as {
      WebGLRenderer: new (options: { canvas: HeadlessSurface; antialias: boolean; alpha: boolean }) => NonNullable<typeof renderer>;
    };
    const viewerMod = nodeRequire("prismarine-viewer") as {
      viewer: {
        Viewer: new (renderer: unknown) => {
          scene: unknown;
          camera: { position: { set(x: number, y: number, z: number): void }; rotation: { order: string; set(x: number, y: number, z: number): void } };
          setVersion(version: string): boolean;
          listen(emitter: unknown): void;
          waitForChunksToRender(): Promise<void>;
          world: { workers?: { terminate(): Promise<number> }[] };
        };
        WorldView: new (world: unknown, distance: number, position: unknown) => NonNullable<typeof worldView>;
      };
    };
    canvas = createHeadlessCanvas(width, height);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    renderer.setSize(width, height, false);
    const viewer = new viewerMod.viewer.Viewer(renderer);
    workers = viewer.world.workers ?? [];
    if (!hadWindow) {
      (global as { window?: { innerWidth: number; innerHeight: number; alert(): void } }).window = {
        innerWidth: width,
        innerHeight: height,
        alert() { /* headless */ }
      };
    }
    const supported = viewer.setVersion(bot.version);
    if (!hadWindow) delete (global as { window?: unknown }).window;
    if (!supported) {
      return { ok: false, code: "viewer.version", message: `This Minecraft version cannot be rendered (${bot.version}).` };
    }
    const pos = bot.entity.position;
    const yaw = input.yaw ?? bot.entity.yaw;
    const pitch = input.pitch ?? bot.entity.pitch;
    worldView = new viewerMod.viewer.WorldView(bot.world, viewDistance, pos);
    viewer.listen(worldView);
    viewer.camera.position.set(pos.x, pos.y + 1.62, pos.z);
    viewer.camera.rotation.order = "ZYX";
    viewer.camera.rotation.set(pitch, yaw, 0);
    const chunks = (bot as { waitForChunksToLoad?: () => Promise<void> }).waitForChunksToLoad;
    if (chunks) await Promise.race([chunks.call(bot), delay(8_000)]);
    await worldView.init(pos);
    await Promise.race([viewer.waitForChunksToRender(), delay(12_000)]);
    renderer.render(viewer.scene, viewer.camera);
    const png = canvas.toBuffer("image/png");
    if (png.length < 32 || png[0] !== 0x89 || png[1] !== 0x50) {
      return { ok: false, code: "viewer.render", message: "The POV frame did not produce a PNG." };
    }
    return { ok: true, mimeType: "image/png", base64: png.toString("base64"), width, height };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("POV snapshot failed", message);
    return {
      ok: false,
      code: "viewer.webgl_unavailable",
      message: `The built-in POV renderer failed (${width}x${height}). ${message}`
    };
  } finally {
    if (!hadWindow) delete (global as { window?: unknown }).window;
    try {
      worldView?.removeListenersFromBot?.(bot);
    } catch { /* already detached */ }
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => 0)));
    releaseRenderer(renderer, canvas);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * prismarine-viewer calls require("http").createServer during startup.
 * Node 22+ exposes createServer as a getter, so assigning it throws.
 * Wrap require instead, and force the page onto 127.0.0.1.
 */
export async function runWithLocalViewerServer(start: () => void, onServer?: (server: http.Server) => void): Promise<void> {
  const Module = nodeRequire("module") as { prototype: { require: NodeJS.Require } };
  const original = Module.prototype.require;
  Module.prototype.require = function (this: unknown, id: string) {
    const loaded = original.apply(this, arguments as unknown as [string]);
    if (id !== "http" && id !== "node:http") return loaded;
    return new Proxy(loaded as object, {
      get(target, prop, receiver) {
        if (prop !== "createServer") return Reflect.get(target, prop, receiver);
        const create = Reflect.get(target, prop, receiver) as typeof http.createServer;
        return (...args: Parameters<typeof http.createServer>) => {
          const created = create.apply(target, args);
          onServer?.(created);
          const listen = created.listen.bind(created);
          created.listen = ((...listenArgs: unknown[]) => {
            const [port, host, backlog, callback] = listenArgs;
            if (typeof host === "function" || host === undefined) {
              const done = typeof host === "function" ? host : callback;
              return listen(port as number, "127.0.0.1", done as () => void);
            }
            return listen(port as number, host as string, backlog as number, callback as () => void);
          }) as typeof created.listen;
          return created;
        };
      }
    });
  } as NodeJS.Require;
  try {
    start();
  } finally {
    Module.prototype.require = original;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

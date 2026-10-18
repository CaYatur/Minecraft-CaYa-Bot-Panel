import * as http from "http";
import type { Bot } from "mineflayer";
import { createLogger } from "../../utils/logger";
import { describeScene, inViewCone, type ScenePoint } from "./describe";

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
export async function startView(botId: string, bot: Bot, version: string): Promise<{ ok: true; url: string; port: number } | { ok: false; code: string; message: string }> {
  if (!version) return { ok: false, code: "viewer.version", message: "This bot has no Minecraft version yet." };
  await stopView(botId);
  let viewer: ((bot: Bot, options: { port: number; firstPerson: boolean }) => void) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("prismarine-viewer");
    viewer = mod.mineflayer ?? mod.default?.mineflayer;
  } catch {
    viewer = undefined;
  }
  if (!viewer) {
    return {
      ok: false,
      code: "viewer.unavailable",
      message: "prismarine-viewer is not installed. The text POV description still works."
    };
  }
  const port = await freePort();
  const captured: http.Server[] = [];
  const httpAny = http as unknown as { createServer: typeof http.createServer };
  const original = httpAny.createServer;
  httpAny.createServer = ((...args: Parameters<typeof http.createServer>) => {
    const created = original.apply(http, args);
    captured.push(created);
    return created;
  }) as typeof http.createServer;
  try {
    viewer(bot, { port, firstPerson: false });
  } catch (err) {
    httpAny.createServer = original;
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Viewer failed to start", message);
    return { ok: false, code: "viewer.version", message: `This Minecraft version cannot be shown in the 3D viewer (${version}). ${message}` };
  }
  httpAny.createServer = original;
  const server = captured[0];
  sessions.set(botId, {
    port,
    bot,
    lastSeen: Date.now(),
    close: () => {
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

export async function renderSnapshot(input: { width?: number; height?: number }): Promise<{ ok: true; mimeType: string; base64: string } | { ok: false; code: string; message: string }> {
  const width = Math.min(MAX_WIDTH, Math.max(160, Math.round(input.width ?? 640)));
  const height = Math.min(MAX_HEIGHT, Math.max(120, Math.round(input.height ?? 360)));
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("node-canvas-webgl");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("prismarine-viewer");
  } catch {
    return {
      ok: false,
      code: "viewer.webgl_unavailable",
      message: `Headless WebGL is not available, so no PNG was rendered (${width}x${height}, cap ${MAX_WIDTH}x${MAX_HEIGHT}). Use bot_view_describe for the same view as text.`
    };
  }
  return {
    ok: false,
    code: "viewer.webgl_unavailable",
    message: "The WebGL packages loaded, but this build does not render a headless frame yet. Use the live viewer or bot_view_describe."
  };
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

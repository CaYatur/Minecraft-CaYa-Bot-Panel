import type { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import type { BotInstance } from "../../core/BotInstance";
import type { ProgressFn, TaskToken } from "../../core/TaskQueue";
import type { MovementConfig } from "../../types";
import { v3 } from "../build/vec3util";

/**
 * Gelişmiş parkur:
 * - pathfinder allowParkour + sprint (2 blok boşluklar)
 * - özel gap jump: 2 / 3 / 4 blok yatay atlama
 * - merdiven: tırman + merdivenden merdivene / kenara atlama
 */

export type ParkourGap = 2 | 3 | 4;

export interface ParkourConfig {
  /** pathfinder parkour (varsayılan true) */
  enabled: boolean;
  /** özel gap jump üst sınırı: 2 | 3 | 4 (aynı Y). Aşağı sprint daha uzağa gidebilir. */
  maxGap: ParkourGap;
  /** merdiven parkuru / tırmanma */
  ladderParkour: boolean;
  /** sprint zorunlu (3–4 blok for) */
  sprintJumps: boolean;
}

export function parkourFromMovement(cfg: MovementConfig): ParkourConfig {
  const maxGap = Math.min(4, Math.max(2, Math.floor(cfg.parkourMaxGap ?? 3))) as ParkourGap;
  return {
    enabled: cfg.allowParkour !== false,
    maxGap,
    ladderParkour: cfg.ladderParkour !== false,
    sprintJumps: cfg.parkourSprint !== false
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const parkourLocks = new WeakSet<Bot>();

export function isParkourLocked(bot: Bot | null | undefined): boolean {
  return Boolean(bot && parkourLocks.has(bot));
}

/** circular import yok — parkour kendi Movements kurar */
function ensureParkourBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline");
  const anyBot = bot as unknown as { pathfinder?: { setMovements(m: unknown): void; setGoal(g: unknown): void } };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);
  const cfg = instance.config.movement;
  const movements = new Movements(bot);
  movements.canDig = Boolean(cfg.canDig);
  movements.allowSprinting = cfg.parkourSprint !== false && cfg.allowSprint !== false;
  movements.allowParkour = cfg.allowParkour !== false;
  movements.allow1by1towers = Boolean(cfg.allowTower);
  try {
    (movements as { maxDropDown?: number }).maxDropDown = Math.max(cfg.maxDrop ?? 3, Math.min(8, (cfg.parkourMaxGap ?? 3) + 2));
  } catch {
    /* */
  }
  bot.pathfinder.setMovements(movements);
  return bot;
}

function clearControls(bot: Bot) {
  for (const k of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
    try {
      bot.setControlState(k, false);
    } catch {
      /* */
    }
  }
}

// caya-rubberband-fix-v1: Pathfinder ile manuel kontrol arasında tek sahipli safe devir.
const caya_rubberband_fix_v1 = true;
async function handoffToManualControl(bot: Bot, settleMs = 140): Promise<void> {
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* pathfinder henüz hazır olmayabilir */
  }
  clearControls(bot);

  const until = Date.now() + Math.max(40, settleMs);
  while (Date.now() < until) {
    try {
      const pf = bot.pathfinder as unknown as { isMoving?(): boolean };
      if (pf.isMoving?.() === false) break;
    } catch {
      break;
    }
    await sleep(20);
  }

  // En az iki fizik tick'i: eski pathfinder kontrol paketlerinin boşalması for.
  await sleep(50);
  clearControls(bot);
}

async function alignManualLookAt(bot: Bot, target: ReturnType<typeof v3>): Promise<void> {
  // force=false: anlık yaw sıçraması/anti-cheat düzeltmesi üretmez.
  try {
    await bot.lookAt(target, false);
  } catch {
    /* bakış failedsa hareket kodu safe biçimde devam eder */
  }
  await sleep(50);
}

async function alignManualYaw(bot: Bot, yaw: number, pitch = 0): Promise<void> {
  try {
    await bot.look(yaw, pitch, false);
  } catch {
    /* bakış failedsa hareket kodu safe biçimde devam eder */
  }
  await sleep(50);
}

function isSolid(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return false;
  const n = b.name.replace(/^minecraft:/, "");
  if (n === "air" || n === "cave_air" || n === "void_air" || n === "water" || n === "lava") return false;
  if (b.boundingBox && b.boundingBox !== "block") return false;
  return true;
}

function isAirish(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return true;
  const n = b.name.replace(/^minecraft:/, "");
  return n === "air" || n === "cave_air" || n === "void_air" || n === "light";
}

/** Stand on THIS Y — a pit floor 2 down is not "still on the platform". */
function isPlatformStand(bot: Bot, x: number, y: number, z: number): boolean {
  return isSolid(bot, x, y - 1, z) && isAirish(bot, x, y, z) && isAirish(bot, x, y + 1, z);
}

function isOpenableCell(bot: Bot, x: number, y: number, z: number): boolean {
  for (const dy of [0, -1, 1]) {
    const b = bot.blockAt(v3(x, y + dy, z));
    const n = String(b?.name ?? "").toLowerCase();
    if (!n || n.includes("iron_")) continue;
    if (n.endsWith("_door") || n.endsWith("_fence_gate") || n.endsWith("_trapdoor")) return true;
  }
  return false;
}

/** Y the player would stand at in this cell, or null if nothing to land on. */
function standYAt(bot: Bot, x: number, yHint: number, z: number, maxDown = 8): number | null {
  for (let dy = 0; dy >= -maxDown; dy--) {
    if (isPlatformStand(bot, x, yHint + dy, z)) return yHint + dy;
  }
  if (isPlatformStand(bot, x, yHint + 1, z)) return yHint + 1;
  return null;
}

/** Same-level 1–2 block hops stay on pathfinder. We only take long / down sprint jumps. */
export function isLongSprintGap(land: { y: number; gap: number }, botY: number): boolean {
  const drop = botY - land.y;
  return land.gap >= 4 || (drop >= 2 && land.gap >= 3) || (drop >= 4 && land.gap >= 2);
}

function maxAirForDrop(drop: number, sameLevelMax: number): number {
  if (drop <= 0) return sameLevelMax;
  // Downward sprint carries extra horizontal distance (~+1 block per drop, capped).
  return Math.min(10, Math.max(sameLevelMax, 4 + Math.min(drop, 6)));
}

function maxSafeDrop(bot: Bot): number {
  const hp = Math.max(0, bot.health ?? 20);
  return Math.min(10, 3 + Math.max(0, Math.floor(hp - 4)));
}

/** Horizontal distance to the first hole at the current platform Y. */
function distToFrontEdge(bot: Bot, ux: number, uz: number): number {
  const pos = bot.entity?.position;
  if (!pos) return 0;
  const py = Math.floor(pos.y);
  for (let t = 0.05; t <= 4.05; t += 0.1) {
    const x = Math.floor(pos.x + ux * t);
    const z = Math.floor(pos.z + uz * t);
    // Doors are a walk-through, not a cliff.
    if (isOpenableCell(bot, x, py, z) || isPlatformStand(bot, x, py, z)) continue;
    return t;
  }
  return 4;
}

async function waitTicks(bot: Bot, ticks: number): Promise<void> {
  try {
    await bot.waitForTicks(ticks);
  } catch {
    await sleep(Math.max(50, ticks * 50));
  }
}

function isLadder(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return false;
  const n = b.name.replace(/^minecraft:/, "");
  return n === "ladder" || n === "vine" || n.includes("vine") || n === "scaffolding" || n === "twisting_vines" || n === "weeping_vines";
}

/** Yatay boşluk blok sayısı (ayak noktaları arası - 1) */
export function measureGapBlocks(
  from: { x: number; z: number },
  to: { x: number; z: number }
): number {
  const dx = Math.abs(Math.floor(to.x) - Math.floor(from.x));
  const dz = Math.abs(Math.floor(to.z) - Math.floor(from.z));
  // chebyshev-ish: max eksen farkı - 1 = boşluktaki air sayısı yaklaşık
  return Math.max(dx, dz);
}

type GapLanding = { x: number; y: number; z: number; gap: number; score: number };

function scanGapAlongStep(
  bot: Bot,
  origin: { x: number; y: number; z: number },
  step: { dx: number; dz: number },
  maxGap: number,
  goal: { x: number; y: number; z: number }
): GapLanding | null {
  if (step.dx === 0 && step.dz === 0) return null;
  const px = Math.floor(origin.x);
  const py = Math.floor(origin.y);
  const pz = Math.floor(origin.z);
  let gapStart = 0;
  let best: GapLanding | null = null;

  for (let d = 1; d <= 13; d++) {
    const cx = px + step.dx * d;
    const cz = pz + step.dz * d;
    if (isOpenableCell(bot, cx, py, cz)) return best;
    // Landing may be several blocks BELOW takeoff (downward sprint). Do not require same Y.
    const sy = standYAt(bot, cx, py, cz);
    if (sy === null) {
      if (gapStart === 0) {
        if (d > 3) break;
        gapStart = d;
      }
      continue;
    }
    if (gapStart === 0) continue;
    const airBlocks = d - gapStart;
    const drop = py - sy;
    if (drop > maxSafeDrop(bot)) continue;
    const maxAir = maxAirForDrop(drop, maxGap);
    if (airBlocks < 2 || airBlocks > maxAir) continue;

    const flyY = Math.max(py, sy);
    let blocked = false;
    for (let t = gapStart; t < d; t++) {
      const mx = px + step.dx * t;
      const mz = pz + step.dz * t;
      if (isOpenableCell(bot, mx, py, mz)) {
        blocked = true;
        break;
      }
      if (isSolid(bot, mx, flyY, mz) || isSolid(bot, mx, flyY + 1, mz)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const toGoal = Math.hypot(goal.x - (cx + 0.5), goal.y - sy, goal.z - (cz + 0.5));
    const fromHere = Math.hypot(goal.x - origin.x, goal.z - origin.z);
    if (fromHere - toGoal < 1.2) continue;
    const cand: GapLanding = { x: cx, y: sy, z: cz, gap: airBlocks, score: toGoal + airBlocks * 0.08 };
    if (!best || cand.score < best.score) best = cand;
    if (toGoal < 1.5) break;
  }
  return best;
}

/**
 * Nearby parkour landing toward the goal.
 * Same-level cap is maxGap (2–4). Downward sprint may land 5–10 blocks out.
 */
export function findGapLanding(
  bot: Bot,
  goal: { x: number; y: number; z: number },
  maxGap: number = 4
): { x: number; y: number; z: number; gap: number } | null {
  if (!bot.entity) return null;
  const pos = bot.entity.position;
  const gdx = goal.x - pos.x;
  const gdz = goal.z - pos.z;
  if (Math.hypot(gdx, gdz) < 2.4) return null;

  const sx = Math.abs(gdx) >= 0.25 ? (gdx > 0 ? 1 : -1) : 0;
  const sz = Math.abs(gdz) >= 0.25 ? (gdz > 0 ? 1 : -1) : 0;
  const steps: Array<{ dx: number; dz: number }> = [];
  if (sx) steps.push({ dx: sx, dz: 0 });
  if (sz) steps.push({ dx: 0, dz: sz });
  if (sx && sz) steps.push({ dx: sx, dz: sz });

  const origin = { x: pos.x, y: pos.y, z: pos.z };
  let best: GapLanding | null = null;
  for (const step of steps) {
    const found = scanGapAlongStep(bot, origin, step, maxGap, goal);
    if (found && (!best || found.score < best.score)) best = found;
  }

  // Odd angles: step along the unit heading in whole-block increments.
  if (!best) {
    const glen = Math.hypot(gdx, gdz) || 1;
    const found = scanGapAlongStep(
      bot,
      origin,
      { dx: Math.round(gdx / glen) || 0, dz: Math.round(gdz / glen) || 0 },
      maxGap,
      goal
    );
    if (found) best = found;
  }

  return best ? { x: best.x, y: best.y, z: best.z, gap: best.gap } : null;
}

type PathNode = { x: number; y: number; z: number };

/**
 * Follow goal that does not treat "standing under the player" as almost-there.
 * Ground-floor A* otherwise camps the house while the player is on the roof;
 * a land-connected sky platform is a longer XZ path but the correct height.
 */
export class GoalFollowAtHeight extends goals.Goal {
  entity: Entity;
  rangeSq: number;
  x: number;
  y: number;
  z: number;

  constructor(entity: Entity, range: number) {
    super();
    this.entity = entity;
    this.rangeSq = range * range;
    const p = entity.position;
    this.x = Math.floor(p.x);
    this.y = Math.floor(p.y);
    this.z = Math.floor(p.z);
  }

  heuristic(node: PathNode): number {
    const dx = this.x - node.x;
    const dy = this.y - node.y;
    const dz = this.z - node.z;
    const xz = Math.hypot(dx, dz);
    if (dy > 1.8) {
      // Standing under the player is the worst node, not the closest.
      const underPenalty = xz < 6 ? (6 - xz) * 12 : 0;
      return dy * 7 + xz * 0.25 + underPenalty;
    }
    return xz + Math.abs(dy);
  }

  isEnd(node: PathNode): boolean {
    const dx = this.x - node.x;
    const dy = this.y - node.y;
    const dz = this.z - node.z;
    if (Math.abs(dy) > 1.7) return false;
    return dx * dx + dy * dy + dz * dz <= this.rangeSq;
  }

  hasChanged(): boolean {
    const p = this.entity.position.floored();
    const dx = this.x - p.x;
    const dz = this.z - p.z;
    const dy = Math.abs(this.y - p.y);
    // Ignore jump-bob and small steps so a long detour is not aborted.
    if (dx * dx + dz * dz > 16 || dy > 2.2) {
      this.x = p.x;
      this.y = p.y;
      this.z = p.z;
      return true;
    }
    return false;
  }

  isValid(): boolean {
    return this.entity != null;
  }
}

export type ObservedJump = {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  at: number;
};

export function pushObservedJump(
  list: ObservedJump[],
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number }
): void {
  const dxz = Math.hypot(to.x - from.x, to.z - from.z);
  if (dxz < 1.7) return;
  list.push({
    from: { x: from.x, y: from.y, z: from.z },
    to: { x: to.x, y: to.y, z: to.z },
    at: Date.now()
  });
  while (list.length > 8) list.shift();
}

export function pruneObservedJumps(list: ObservedJump[], maxAgeMs = 45_000): void {
  const t0 = Date.now();
  while (list.length && t0 - list[0]!.at > maxAgeMs) list.shift();
}

/** If we are standing on a takeoff the player already used, copy that jump. */
export function findReplayJump(bot: Bot, list: ObservedJump[]): ObservedJump | null {
  if (!bot.entity?.onGround) return null;
  const p = bot.entity.position;
  let best: ObservedJump | null = null;
  let bestD = 1.75;
  const now = Date.now();
  for (const jump of list) {
    if (now - jump.at > 45_000) continue;
    const dFrom = Math.hypot(p.x - jump.from.x, p.z - jump.from.z);
    if (dFrom > bestD || Math.abs(p.y - jump.from.y) > 1.3) continue;
    const dTo = Math.hypot(p.x - jump.to.x, p.z - jump.to.z);
    if (dTo <= dFrom + 0.2) continue;
    const lx = Math.floor(jump.to.x);
    const ly = Math.floor(jump.to.y);
    const lz = Math.floor(jump.to.z);
    if (standYAt(bot, lx, ly, lz) == null && !isPlatformStand(bot, lx, ly, lz)) continue;
    best = jump;
    bestD = dFrom;
  }
  return best;
}

/**
 * Connected platform at the player's height, on the land side — not the isolated roof
 * the player is standing on, and not the ground under them.
 */
export function findElevatedApproach(
  bot: Bot,
  goal: { x: number; y: number; z: number },
  radius = 24
): { x: number; y: number; z: number } | null {
  if (!bot.entity) return null;
  const py = Math.floor(goal.y);
  const bx = bot.entity.position.x;
  const bz = bot.entity.position.z;
  const reach = Math.max(8, Math.min(radius, Math.ceil(Math.hypot(goal.x - bx, goal.z - bz) + 6)));
  let best: { x: number; y: number; z: number; score: number } | null = null;
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      if (dx * dx + dz * dz > reach * reach) continue;
      const x = Math.floor(goal.x) + dx;
      const z = Math.floor(goal.z) + dz;
      for (const y of [py, py - 1]) {
        if (!isPlatformStand(bot, x, y, z)) continue;
        let n = 0;
        if (isPlatformStand(bot, x + 1, y, z)) n++;
        if (isPlatformStand(bot, x - 1, y, z)) n++;
        if (isPlatformStand(bot, x, y, z + 1)) n++;
        if (isPlatformStand(bot, x, y, z - 1)) n++;
        const distP = Math.hypot(x + 0.5 - goal.x, z + 0.5 - goal.z);
        const distB = Math.hypot(x + 0.5 - bx, z + 0.5 - bz);
        if (distP < 2.3 && n <= 2) continue;
        if (n < 2 || distP > 16) continue;
        const score = distP * 0.55 + distB * 0.45 - n * 0.6;
        if (!best || score < best.score) best = { x, y, z, score };
      }
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

/**
 * Back up from the lip so a 3–4 block sprint jump has room to accelerate.
 * Sneak while reversing so we don't fall off the far side.
 */
async function prepareRunUp(
  bot: Bot,
  dir: { ux: number; uz: number },
  gap: number,
  token: TaskToken
): Promise<void> {
  if (gap < 3 || !bot.entity) return;
  const need = gap >= 6 ? 3.2 : gap >= 4 ? 2.6 : 1.8;
  const edge = distToFrontEdge(bot, dir.ux, dir.uz);
  const backDist = need - Math.min(edge, need);
  if (backDist < 0.45) return;

  const pos = bot.entity.position;
  const py = Math.floor(pos.y);
  const bx = pos.x - dir.ux * backDist;
  const bz = pos.z - dir.uz * backDist;
  if (standYAt(bot, Math.floor(bx), py, Math.floor(bz)) === null) return;

  bot.setControlState("sprint", false);
  bot.setControlState("jump", false);
  bot.setControlState("sneak", true);
  await alignManualLookAt(bot, v3(bx, pos.y + 0.4, bz));
  bot.setControlState("forward", true);
  const t0 = Date.now();
  while (Date.now() - t0 < 750 && !token.cancelled && bot.entity) {
    const p = bot.entity.position;
    if (Math.hypot(p.x - bx, p.z - bz) < 0.38) break;
    if (distToFrontEdge(bot, -dir.ux, -dir.uz) < 0.18) break;
    await sleep(20);
  }
  clearControls(bot);
  await sleep(40);
}

/**
 * Hold jump until a physics tick sees onGround+jump. A 50ms pulse often misses the tick
 * and the bot walks off the block instead of jumping.
 */
async function holdJumpUntilAirborne(bot: Bot, token: TaskToken): Promise<void> {
  bot.setControlState("jump", true);
  bot.setControlState("sneak", false);
  await waitTicks(bot, 1);
  for (let i = 0; i < 6 && !token.cancelled && bot.entity; i++) {
    bot.setControlState("jump", true);
    if (bot.entity.onGround === false) break;
    await waitTicks(bot, 1);
  }
  await waitTicks(bot, 1);
  try {
    bot.setControlState("jump", false);
  } catch {
    /* */
  }
}

/**
 * Sprint toward the committed landing and jump on the last half of the takeoff block.
 * Jumping at 0.16 is too late at sprint speed — we skip the window and walk off.
 */
async function sprintJumpAtEdge(
  bot: Bot,
  dir: { ux: number; uz: number },
  gap: number,
  token: TaskToken
): Promise<void> {
  const maxMs = 400 + gap * 220;
  const jumpAt = gap >= 6 ? 0.7 : gap >= 4 ? 0.62 : 0.55;
  bot.setControlState("sneak", false);
  bot.setControlState("forward", true);
  bot.setControlState("sprint", true);
  bot.setControlState("jump", false);

  const t0 = Date.now();
  let jumped = false;
  while (Date.now() - t0 < maxMs && !token.cancelled && bot.entity) {
    const onGround = bot.entity.onGround !== false;
    const edge = distToFrontEdge(bot, dir.ux, dir.uz);
    if (!jumped && onGround && edge <= jumpAt) {
      jumped = true;
      await holdJumpUntilAirborne(bot, token);
      break;
    }
    if (!jumped && !onGround) {
      jumped = true;
      await holdJumpUntilAirborne(bot, token);
      break;
    }
    await sleep(16);
  }
  if (!jumped && bot.entity) {
    await holdJumpUntilAirborne(bot, token);
  }
}

/**
 * Sprint jump: run-up + hold jump until airborne. Used only for long / down gaps.
 * Once airborne, look and controls stay on the landing — no retarget.
 */
export async function executeGapJump(
  instance: BotInstance,
  landing: { x: number; y: number; z: number },
  gap: number,
  token: TaskToken,
  report?: ProgressFn
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return false;
  const ownsLock = !parkourLocks.has(bot);
  if (ownsLock) parkourLocks.add(bot);

  const g = Math.min(10, Math.max(2, Math.round(gap)));
  report?.({ done: 0, total: 1, label: `parkur ${g} blok atlama → ${landing.x},${landing.y},${landing.z}` });
  try {
    await handoffToManualControl(bot);

    const lx = landing.x + 0.5;
    const ly = landing.y;
    const lz = landing.z + 0.5;
    const pos0 = bot.entity.position;
    const drop = Math.max(0, pos0.y - ly);
    const dx = lx - pos0.x;
    const dz = lz - pos0.z;
    const len = Math.hypot(dx, dz) || 1;
    const dir = { ux: dx / len, uz: dz / len };

    await prepareRunUp(bot, dir, g, token);
    if (token.cancelled) {
      clearControls(bot);
      throw new Error(token.reason ?? "cancelled");
    }

    // Look toward landing XZ at takeoff eye height — staring down kills sprint distance.
    await alignManualLookAt(bot, v3(lx, pos0.y + 0.3, lz));
    await sprintJumpAtEdge(bot, dir, g, token);
    if (token.cancelled) {
      clearControls(bot);
      throw new Error(token.reason ?? "cancelled");
    }

    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
    const airDeadline = Date.now() + 800 + g * 160 + drop * 90;
    const jumpHoldUntil = Date.now() + 220;
    let fellPast = false;
    while (Date.now() < airDeadline && !token.cancelled) {
      const ent = bot.entity;
      if (!ent) break;
      if (Date.now() < jumpHoldUntil) {
        try {
          bot.setControlState("jump", true);
        } catch {
          /* */
        }
      }
      const pos = ent.position;
      const vy = ent.velocity?.y ?? 0;
      if (pos.y < ly - 2.2 && vy < -0.35) {
        fellPast = true;
        clearControls(bot);
        break;
      }
      const d = Math.hypot(pos.x - lx, pos.z - lz);
      if (ent.onGround && d < 2.1 && Math.abs(pos.y - ly) < Math.max(1.8, drop + 1)) break;
      if (ent.onGround && Date.now() > airDeadline - 400) break;
      await sleep(30);
    }

    clearControls(bot);
    if (fellPast) {
      instance.getLogger().info("Parkour jump", "landing missed — abandoned to MLG");
      await yieldFallToMlg(instance, bot, token);
      return false;
    }
    await sleep(60);
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");

    const pos = bot.entity.position;
    const landed =
      Boolean(bot.entity.onGround) &&
      Math.hypot(pos.x - lx, pos.z - lz) < 2.2 &&
      Math.abs(pos.y - ly) < Math.max(1.8, drop + 1.2);

    if (landed) {
      report?.({ done: 1, total: 1, label: `parkur ${g} OK` });
      instance.getLogger().info(`Parkour jump succeeded`, `${g} blok → ${landing.x},${landing.y},${landing.z}`);
    } else {
      instance.getLogger().debug("Parkour jump weak landing", `gap=${g} d=${Math.hypot(pos.x - lx, pos.z - lz).toFixed(1)}`);
    }
    return landed;
  } finally {
    if (ownsLock) parkourLocks.delete(bot);
  }
}

async function waitTargetStable(
  getPos: () => { x: number; y: number; z: number },
  token: TaskToken,
  stableMs = 550,
  timeoutMs = 2000
): Promise<{ x: number; y: number; z: number }> {
  // XZ only — ignore jump bobbing on the far platform.
  const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
  let last = { ...getPos() };
  let stillSince = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && !token.cancelled) {
    const p = getPos();
    if (horiz(p, last) > 0.45) {
      last = { x: p.x, y: p.y, z: p.z };
      stillSince = Date.now();
    } else if (Date.now() - stillSince >= stableMs) {
      return { x: p.x, y: p.y, z: p.z };
    }
    await sleep(50);
  }
  const p = getPos();
  return { x: p.x, y: p.y, z: p.z };
}

/** Follow/goto: wait until the target stops jittering, then one locked sprint-jump. */
export async function tryCommittedGapJumpToward(
  instance: BotInstance,
  target: { position: { x: number; y: number; z: number } },
  token: TaskToken,
  report?: ProgressFn
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return false;
  if (parkourLocks.has(bot)) return false;
  const cfg = parkourFromMovement(instance.config.movement);
  if (!cfg.enabled) return false;

  const botY = bot.entity.position.y;
  // Player above us: do not invent an up-jump into the void under a roof.
  if (target.position.y - botY > 2.2) return false;
  const preview = findGapLanding(bot, target.position, 10);
  if (!preview || !isLongSprintGap(preview, botY)) return false;

  parkourLocks.add(bot);
  try {
    await handoffToManualControl(bot, 80);
    if (token.cancelled) return false;

    report?.({ done: 0, total: 1, label: "parkur: hedef dursun" });
    const aim = await waitTargetStable(() => {
      const p = target.position;
      return { x: p.x, y: p.y, z: p.z };
    }, token);
    if (token.cancelled) return false;
    const land = findGapLanding(bot, aim, 10) ?? preview;
    if (!isLongSprintGap(land, bot.entity.position.y)) return false;
    instance.getLogger().info("Committed gap jump", `gap=${land.gap} drop≈${(botY - land.y).toFixed(0)} → ${land.x},${land.y},${land.z}`);
    return await executeGapJump(instance, land, land.gap, token, report);
  } finally {
    parkourLocks.delete(bot);
  }
}

/** Copy a jump the followed player already completed. Do not invent a new line. */
export async function tryReplayObservedJump(
  instance: BotInstance,
  jump: ObservedJump,
  token: TaskToken,
  report?: ProgressFn
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return false;
  if (parkourLocks.has(bot)) return false;
  const lx = Math.floor(jump.to.x);
  const ly = standYAt(bot, lx, Math.floor(jump.to.y), Math.floor(jump.to.z)) ?? Math.floor(jump.to.y);
  const lz = Math.floor(jump.to.z);
  const gap = Math.max(
    2,
    Math.min(10, Math.round(Math.hypot(jump.to.x - jump.from.x, jump.to.z - jump.from.z)))
  );
  instance.getLogger().info("Replay player jump", `gap≈${gap} → ${lx},${ly},${lz}`);
  return executeGapJump(instance, { x: lx, y: ly, z: lz }, gap, token, report);
}

type LadderPos = { x: number; y: number; z: number };

/** Ayak hizası merdiven (yatay ±1, dikey ±1) */
function findNearbyLadder(bot: Bot, fx: number, fy: number, fz: number): LadderPos | null {
  for (const dy of [0, 1, -1]) {
    for (const dx of [0, 1, -1]) {
      for (const dz of [0, 1, -1]) {
        if (isLadder(bot, fx + dx, fy + dy, fz + dz)) {
          return { x: fx + dx, y: fy + dy, z: fz + dz };
        }
      }
    }
  }
  return null;
}

/** Sütun: ayaktaki merdivenden yukarı en üst merdiven Y (+1 stand) */
function ladderColumnTopY(bot: Bot, lx: number, ly: number, lz: number, maxUp = 48): number {
  let y = ly;
  for (let i = 0; i < maxUp; i++) {
    if (isLadder(bot, lx, y + 1, lz)) y++;
    else break;
  }
  // tepedeki merdiven bloğunun üstü stand noktası
  return y + 1;
}

function stillOnLadder(bot: Bot): boolean {
  if (!bot.entity) return false;
  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);
  return isLadder(bot, fx, fy, fz) || isLadder(bot, fx, fy + 1, fz) || isLadder(bot, fx, Math.floor(p.y - 0.15), fz);
}

/** facing = merdivenin baktığı yön; duvar = tersi. Duvara doğru birim vektör. */
function ladderIntoWall(bot: Bot, lx: number, ly: number, lz: number): { x: number; z: number; yaw: number } {
  const b = bot.blockAt(v3(lx, ly, lz));
  let face = "";
  try {
    const props = (b as { getProperties?: () => Record<string, unknown> })?.getProperties?.();
    face = String(props?.facing ?? "").toLowerCase();
  } catch {
    /* */
  }
  // facing north = merdiven güneye bakıyor? MC: ladder facing = direction of the open side (player stands).
  // Oyuncu facing yönünde merdivene bakarak forward basar.
  if (face === "north") return { x: 0, z: -1, yaw: Math.PI }; // look north
  if (face === "south") return { x: 0, z: 1, yaw: 0 };
  if (face === "west") return { x: -1, z: 0, yaw: Math.PI / 2 };
  if (face === "east") return { x: 1, z: 0, yaw: -Math.PI / 2 };
  // bilinmiyor — merdiven merkezine bak
  return { x: 0, z: 0, yaw: bot.entity?.yaw ?? 0 };
}

/**
 * Düşüş: kontrol drop, MLG'ye drop, lookAt yok.
 */
async function yieldFallToMlg(
  instance: BotInstance,
  bot: Bot,
  token: TaskToken,
  maxMs = 5500
): Promise<void> {
  clearControls(bot);
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }
  const t0 = Date.now();
  let sawMlg = false;
  while (!token.cancelled && Date.now() - t0 < maxMs) {
    if (!bot.entity) break;
    const vy = bot.entity.velocity?.y ?? 0;
    clearControls(bot);
    const fg = instance.survival?.getFallGuardState?.();
    if (fg?.active || (fg?.falling && fg.method)) {
      sawMlg = true;
      await sleep(40);
      continue;
    }
    if (bot.entity.onGround && Math.abs(vy) < 0.12) {
      if (sawMlg) await sleep(120);
      break;
    }
    await sleep(40);
  }
  clearControls(bot);
  await sleep(60);
}

export type ClimbAbortFn = () => boolean;

function isAborted(token: TaskToken, shouldAbort?: ClimbAbortFn): boolean {
  if (token.cancelled) return true;
  try {
    if (shouldAbort?.()) return true;
  } catch {
    /* */
  }
  return false;
}

/** Pathfinder ile merdiven üstüne çıkmayı dene — takılınca / abort'ta hemen drop */
async function climbViaPathfinder(
  instance: BotInstance,
  bot: Bot,
  top: { x: number; y: number; z: number },
  token: TaskToken,
  timeoutMs: number,
  shouldAbort?: ClimbAbortFn
): Promise<boolean> {
  ensureParkourBot(instance);
  const goal = new goals.GoalNear(top.x, top.y, top.z, 1.5);
  return new Promise((resolve) => {
    let settled = false;
    let lastY = bot.entity?.position.y ?? 0;
    let lastProgressAt = Date.now();
    const stop = () => {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
    };
    const cleanup = () => {
      clearInterval(watch);
      clearTimeout(deadline);
      bot.removeListener("goal_reached", onReached);
      bot.removeListener("path_update", onPath);
    };
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      stop();
      clearControls(bot);
      resolve(ok);
    };
    const onReached = () => done(true);
    const onPath = (r: { status: string }) => {
      if (r.status === "noPath" || r.status === "timeout") done(false);
    };
    const watch = setInterval(() => {
      if (settled) return;
      if (isAborted(token, shouldAbort)) {
        instance.getLogger().info("Ladder path cancelled", "target changed / cancelled — abandoned");
        done(false);
        return;
      }
      if (!bot.entity) {
        done(false);
        return;
      }
      const y = bot.entity.position.y;
      if (y >= top.y - 0.7) {
        done(true);
        return;
      }
      // Y ilerlemesi yok → takıldı, 14s bekleme
      if (y > lastY + 0.12) {
        lastY = y;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > 2800) {
        instance.getLogger().info("Merdiven path stuck", `${(Date.now() - lastProgressAt) / 1000}s ilerleme yok — drop`);
        done(false);
      }
    }, 150);
    const deadline = setTimeout(() => {
      const y = bot.entity?.position.y ?? 0;
      done(y >= top.y - 0.85);
    }, timeoutMs);
    bot.on("goal_reached", onReached);
    bot.on("path_update", onPath);
    try {
      bot.pathfinder.setGoal(goal);
    } catch {
      done(false);
    }
  });
}

/**
 * Manuel tırmanış (vanilla): duvara bak + forward basılı + jump basılı.
 * Pulse jump düşürür; sürekli basılı daha stabil.
 */
async function climbManualHold(
  instance: BotInstance,
  bot: Bot,
  ladder: LadderPos,
  targetY: number,
  token: TaskToken,
  report?: ProgressFn,
  shouldAbort?: ClimbAbortFn,
  maxMs = 12_000
): Promise<"ok" | "fell" | "stuck" | "abort"> {
  const wall = ladderIntoWall(bot, ladder.x, ladder.y, ladder.z);
  const startY = bot.entity!.position.y;
  let peakY = startY;
  let lastProgressY = startY;
  let lastProgressAt = Date.now();
  let reattachOnce = false;
  const t0 = Date.now();

  await handoffToManualControl(bot);

  try {
    await alignManualYaw(bot, wall.yaw, 0);
  } catch {
    await alignManualLookAt(bot, v3(ladder.x + 0.5, bot.entity!.position.y + 0.4, ladder.z + 0.5));
  }

  bot.setControlState("sprint", false);
  bot.setControlState("sneak", false);
  bot.setControlState("forward", true);
  await sleep(160);
  bot.setControlState("jump", true);

  while (!isAborted(token, shouldAbort) && Date.now() - t0 < maxMs) {
    if (!bot.entity) return "stuck";
    const p = bot.entity.position;
    if (p.y > peakY) peakY = p.y;
    if (p.y >= targetY - 0.35) {
      clearControls(bot);
      return "ok";
    }

    // target artık bu yüksekliği istemiyorsa (oyuncu indi / target değişti)
    if (shouldAbort?.()) {
      clearControls(bot);
      instance.getLogger().info("Ladder manual cancelled", "target no longer needs ladder");
      return "abort";
    }

    const vy = bot.entity.velocity?.y ?? 0;
    const drop = peakY - p.y;

    if ((vy < -0.35 && !stillOnLadder(bot)) || (drop >= 1.4 && !stillOnLadder(bot)) || (drop >= 1.8 && vy < -0.4)) {
      clearControls(bot);
      instance.getLogger().info("Fell from ladder", `peak=${peakY.toFixed(1)} y=${p.y.toFixed(1)} — MLG`);
      await yieldFallToMlg(instance, bot, token);
      return "fell";
    }
    if (bot.entity.onGround && drop >= 1.0 && !stillOnLadder(bot)) {
      clearControls(bot);
      return "fell";
    }
    // Tırmanış sırasında yaw sahibi manuel momentumdur; her tick bakış zorlanmaz.
    bot.setControlState("sprint", false);
    bot.setControlState("forward", true);
    bot.setControlState("jump", true);

    if (p.y > lastProgressY + 0.12) {
      lastProgressY = p.y;
      lastProgressAt = Date.now();
      reattachOnce = false;
    } else if (Date.now() - lastProgressAt > 2200) {
      // bir kez yeniden yapış; olmazsa hemen drop (takılı kalma yok)
      if (!reattachOnce) {
        reattachOnce = true;
        clearControls(bot);
        await sleep(100);
        if (!bot.entity) return "stuck";
        if (!stillOnLadder(bot) && bot.entity.onGround) {
          bot.setControlState("forward", true);
          await sleep(150);
        }
        await alignManualYaw(bot, wall.yaw, 0);
        bot.setControlState("forward", true);
        bot.setControlState("jump", true);
        lastProgressAt = Date.now();
      } else {
        clearControls(bot);
        instance.getLogger().info("Ladder stuck", "ilerleme yok — abandoned (targete kilit yok)");
        return "stuck";
      }
    }

    report?.({
      done: 0,
      total: 1,
      label: `merdiven y=${p.y.toFixed(1)} → ${targetY.toFixed(0)}`
    });
    await sleep(80);
  }

  clearControls(bot);
  if (isAborted(token, shouldAbort)) return "abort";
  if (bot.entity && bot.entity.position.y >= targetY - 0.5) return "ok";
  return "stuck";
}

/** Tepe çıkışı: solid komşu hücreye yürü */
async function exitLadderTop(bot: Bot): Promise<void> {
  if (!bot.entity) return;
  const fx = Math.floor(bot.entity.position.x);
  const fy = Math.floor(bot.entity.position.y);
  const fz = Math.floor(bot.entity.position.z);
  type Land = { dx: number; dz: number; score: number };
  const lands: Land[] = [];
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ] as const) {
    if (!isSolid(bot, fx + dx, fy - 1, fz + dz)) continue;
    if (!isAirish(bot, fx + dx, fy, fz + dz)) continue;
    if (!isAirish(bot, fx + dx, fy + 1, fz + dz)) continue;
    lands.push({ dx, dz, score: Math.abs(dx) + Math.abs(dz) });
  }
  lands.sort((a, b) => a.score - b.score);
  if (lands.length === 0) {
    await sleep(200);
    return;
  }
  const { dx, dz } = lands[0]!;
  clearControls(bot);
  await alignManualLookAt(bot, v3(fx + dx + 0.5, fy, fz + dz + 0.5));
  await sleep(70);
  bot.setControlState("forward", true);
  if (stillOnLadder(bot)) {
    bot.setControlState("jump", true);
    await sleep(60);
    bot.setControlState("jump", false);
  }
  await sleep(220);
  clearControls(bot);
  await sleep(100);
}

export interface ClimbLadderOpts {
  /** true → merdiveni drop (target değişti / oyuncu indi / cancelled) */
  shouldAbort?: ClimbAbortFn;
  /** pathfinder tırmanış üst süre (ms) */
  pathMs?: number;
  /** manuel tırmanış üst süre (ms) */
  manualMs?: number;
}

/**
 * Merdiven tırman:
 * 1) pathfinder  2) manuel hold  3) düşüş→MLG  4) takılınca/abort'ta hemen drop
 * shouldAbort: target oyuncu indiyse / merdiven gerekmiyorsa true dön
 */
export async function climbLadderParkour(
  instance: BotInstance,
  targetY: number,
  token: TaskToken,
  report?: ProgressFn,
  opts?: ClimbLadderOpts
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity) return false;
  const shouldAbort = opts?.shouldAbort;
  const pathMs = opts?.pathMs ?? 7_000;
  const manualMs = opts?.manualMs ?? 10_000;

  ensureParkourBot(instance);
  clearControls(bot);
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }

  if (isAborted(token, shouldAbort)) {
    report?.({ done: 1, total: 1, label: "merdiven cancelled" });
    return false;
  }

  const p0 = bot.entity.position;
  const ladder0 = findNearbyLadder(bot, Math.floor(p0.x), Math.floor(p0.y), Math.floor(p0.z));
  if (!ladder0) {
    report?.({ done: 1, total: 1, label: "merdiven yok" });
    return false;
  }

  const colTopY = ladderColumnTopY(bot, ladder0.x, ladder0.y, ladder0.z);
  let wantY = Math.min(targetY, colTopY);
  // target zaten bu yükseklikte / altındaysa tırmanma
  if (wantY <= p0.y + 0.8) {
    report?.({ done: 1, total: 1, label: "merdiven gerekmiyor" });
    return false;
  }

  report?.({ done: 0, total: 1, label: `merdiven → y=${Math.floor(wantY)}` });
  instance.getLogger().info("Ladder climb", `column top≈${colTopY} target=${wantY.toFixed(1)}`);

  const abortClimb = () => {
    if (isAborted(token, shouldAbort)) return true;
    // canlı target Y düştüyse (shouldAbort forde de olabilir) — ekstra safek yok
    return false;
  };

  // --- A) Pathfinder ---
  const pfOk = await climbViaPathfinder(
    instance,
    bot,
    { x: ladder0.x, y: wantY, z: ladder0.z },
    token,
    pathMs,
    abortClimb
  );
  if (isAborted(token, shouldAbort)) {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: "merdiven cancelled (target)" });
    return false;
  }
  if (pfOk && bot.entity.position.y >= wantY - 0.8) {
    await exitLadderTop(bot);
    const ok = bot.entity.position.y >= wantY - 1.0;
    report?.({ done: 1, total: 1, label: ok ? "ladder OK (path)" : "ladder partial" });
    if (ok) instance.getLogger().info("Merdiven parkuru tamam", `pathfinder y=${bot.entity.position.y.toFixed(1)}`);
    return ok;
  }

  clearControls(bot);
  await sleep(80);
  if (isAborted(token, shouldAbort)) {
    report?.({ done: 1, total: 1, label: "merdiven cancelled (target)" });
    return false;
  }

  // --- B) Manuel ---
  const ladder =
    findNearbyLadder(
      bot,
      Math.floor(bot.entity.position.x),
      Math.floor(bot.entity.position.y),
      Math.floor(bot.entity.position.z)
    ) ?? ladder0;

  report?.({ done: 0, total: 1, label: `merdiven manuel → ${Math.floor(wantY)}` });
  const result = await climbManualHold(
    instance,
    bot,
    ladder,
    wantY,
    token,
    report,
    abortClimb,
    manualMs
  );

  if (result === "abort" || isAborted(token, shouldAbort)) {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: "merdiven cancelled (target)" });
    return false;
  }
  if (result === "fell" || result === "stuck") {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: result === "fell" ? "ladder fell" : "merdiven stuck — abandoned" });
    return false;
  }
  if (result !== "ok" || bot.entity.position.y < wantY - 1.0) {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: "ladder incomplete" });
    return false;
  }

  await sleep(120);
  await exitLadderTop(bot);
  const ok = bot.entity.position.y >= wantY - 1.0;
  report?.({ done: 1, total: 1, label: ok ? "ladder OK" : "ladder partial" });
  if (ok) instance.getLogger().info("Merdiven parkuru tamam", `manuel y=${bot.entity.position.y.toFixed(1)}`);
  return ok;
}

export interface ParkourGotoOpts {
  /**
   * Canlı target (oyuncu takip/goto). Her turda yenilenir.
   * null = target kayboldu → çık.
   */
  liveTarget?: () => { x: number; y: number; z: number } | null;
}

/**
 * Parkour destekli goto: pathfinder + gap jump + merdiven.
 * liveTarget varsa target hareket edince merdiven dropılır / path yenilenir.
 */
export async function runParkourGoto(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  range: number,
  token: TaskToken,
  report: ProgressFn,
  opts?: ParkourGotoOpts
): Promise<void> {
  const bot = instance.bot;
  if (!bot?.entity) throw new Error("Bot offline");
  const cfg = parkourFromMovement(instance.config.movement);

  ensureParkourBot(instance);
  report({ done: 0, total: 1, label: `parkur git → ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}` });

  let gx = x;
  let gy = y;
  let gz = z;
  let attempts = 0;
  const maxAttempts = 8;
  let ladderCooldownUntil = 0;

  const refreshTarget = (): boolean => {
    if (!opts?.liveTarget) return true;
    const t = opts.liveTarget();
    if (!t) return false;
    gx = t.x;
    gy = t.y;
    gz = t.z;
    return true;
  };

  while (!token.cancelled && attempts < maxAttempts) {
    attempts++;
    if (!refreshTarget()) {
      report({ done: 1, total: 1, label: "parkur target kayboldu" });
      return;
    }

    const dist = bot.entity.position.distanceTo(v3(gx, gy, gz) as never);
    if (dist <= range + 0.8) {
      report({ done: 1, total: 1, label: "parkour reached target" });
      return;
    }

    const yNow = bot.entity.position.y;
    // merdiven sadece target hâlâ anlamlı şekilde yukarıdaysa
    const needClimb = cfg.ladderParkour && gy > yNow + 2.2 && Date.now() >= ladderCooldownUntil;
    if (needClimb) {
      const fy = Math.floor(yNow);
      const fx = Math.floor(bot.entity.position.x);
      const fz = Math.floor(bot.entity.position.z);
      let hasLadder = false;
      for (let dy = 0; dy < 6; dy++) {
        if (isLadder(bot, fx, fy + dy, fz)) {
          hasLadder = true;
          break;
        }
      }
      if (hasLadder) {
        const beforeY = yNow;
        const climbTo = Math.min(gy, beforeY + 6);
        const climbed = await climbLadderParkour(instance, climbTo, token, report, {
          shouldAbort: () => {
            if (token.cancelled) return true;
            if (!refreshTarget()) return true;
            // oyuncu indiyse / merdiven artık gereksiz
            if (gy <= (bot.entity?.position.y ?? 0) + 1.5) return true;
            // target yatayda uzaklaştı ve yükseklik farkı azaldı
            const horiz = Math.hypot(
              gx - (bot.entity?.position.x ?? 0),
              gz - (bot.entity?.position.z ?? 0)
            );
            if (horiz > 14 && gy < (bot.entity?.position.y ?? 0) + 3) return true;
            return false;
          },
          pathMs: 6_000,
          manualMs: 8_000
        });
        if (!climbed) {
          ladderCooldownUntil = Date.now() + 4000;
          instance.getLogger().info("Parkur", "merdiven abandoned — pathfinder / yeni target");
          clearControls(bot);
          await sleep(150);
        } else if ((bot.entity?.position.y ?? 0) > beforeY + 0.8) {
          continue;
        }
      }
    }

    if (!refreshTarget()) {
      report({ done: 1, total: 1, label: "parkur target kayboldu" });
      return;
    }

    const goal = new goals.GoalNear(gx, gy, gz, Math.max(1, range));
    try {
      await runPathOnce(instance, goal, token, 20_000);
      if (!refreshTarget()) return;
      if (bot.entity.position.distanceTo(v3(gx, gy, gz) as never) <= range + 1) {
        report({ done: 1, total: 1, label: "parkour reached target" });
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!cfg.enabled || (!msg.includes("noPath") && !msg.includes("yol"))) {
        if (attempts >= maxAttempts) throw e;
      }

      if (!refreshTarget()) return;
      if (cfg.enabled) {
        if (opts?.liveTarget) {
          const live = {
            get position() {
              const t = opts.liveTarget?.();
              return t ?? { x: gx, y: gy, z: gz };
            }
          };
          const ok = await tryCommittedGapJumpToward(instance, live, token, report);
          if (ok) continue;
        } else {
          const land = findGapLanding(bot, { x: gx, y: gy, z: gz }, cfg.maxGap);
          if (land && land.gap <= cfg.maxGap) {
            instance.getLogger().info("Parkur gap jump", `${land.gap} blok → ${land.x},${land.y},${land.z}`);
            const ok = await executeGapJump(instance, land, land.gap, token, report);
            if (ok) continue;
          }
        }
      }

      await sleep(250);
      if (attempts >= maxAttempts) throw e instanceof Error ? e : new Error(msg);
    }
  }

  if (token.cancelled) throw new Error(token.reason ?? "cancelled");
  refreshTarget();
  if (bot.entity.position.distanceTo(v3(gx, gy, gz) as never) > range + 1.5) {
    throw new Error("Could not reach target via parkour");
  }
  report({ done: 1, total: 1, label: "parkour reached target" });
}

async function runPathOnce(
  instance: BotInstance,
  goal: goals.Goal,
  token: TaskToken,
  timeoutMs: number
): Promise<void> {
  const bot = ensureParkourBot(instance);
  return new Promise((resolve, reject) => {
    const stop = () => {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
    };
    const cleanup = () => {
      clearInterval(watch);
      clearTimeout(deadline);
      bot.removeListener("goal_reached", onReached);
      bot.removeListener("path_update", onPath);
    };
    const onReached = () => {
      cleanup();
      resolve();
    };
    const onPath = (r: { status: string }) => {
      if (r.status === "noPath") {
        cleanup();
        stop();
        reject(new Error("noPath"));
      } else if (r.status === "timeout") {
        cleanup();
        stop();
        reject(new Error("path timeout"));
      }
    };
    const watch = setInterval(() => {
      if (token.cancelled) {
        cleanup();
        stop();
        reject(new Error(token.reason ?? "cancelled"));
      }
    }, 200);
    const deadline = setTimeout(() => {
      cleanup();
      stop();
      reject(new Error("parkour path timeout"));
    }, timeoutMs);
    bot.on("goal_reached", onReached);
    bot.on("path_update", onPath);
    try {
      bot.pathfinder.setGoal(goal);
    } catch (e) {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

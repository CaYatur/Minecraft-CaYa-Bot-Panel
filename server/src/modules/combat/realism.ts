import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type { CombatConfig } from "../../types";
import type { TaskToken } from "../../core/TaskQueue";
import { cooldownMsForWeapon } from "./weapons";

/**
 * RealismLayer (§9 D1–D7): every melee hit MUST go through tryRealisticAttack.
 * No mineflayer-pvp; no snap aimbot; no wall hits; no infinite CPS.
 */

export function eyePos(bot: Bot): Vec3 {
  const eyeH = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
  return bot.entity.position.offset(0, eyeH, 0);
}

export function aimPoint(entity: Entity): Vec3 {
  const h = entity.height ?? 1.8;
  return entity.position.offset(0, h * 0.85, 0);
}

export function distanceEyeToEntity(bot: Bot, entity: Entity): number {
  return eyePos(bot).distanceTo(aimPoint(entity));
}

/** D2: reach from config (default 3.0) */
export function inMeleeRange(bot: Bot, entity: Entity, reach: number): boolean {
  return distanceEyeToEntity(bot, entity) <= Math.max(1, reach);
}

/**
 * D3: line-of-sight via world raycast. If a solid block is closer than the target, blocked.
 * Returns true when clear (or raycast unavailable — fail open only when no world).
 */
export function hasLineOfSight(bot: Bot, entity: Entity): boolean {
  const from = eyePos(bot);
  const to = aimPoint(entity);
  const dist = from.distanceTo(to);
  if (dist < 0.15) return true;

  const dx = (to.x - from.x) / dist;
  const dy = (to.y - from.y) / dist;
  const dz = (to.z - from.z) / dist;

  const world = bot.world as unknown as {
    raycast?: (origin: Vec3, direction: Vec3, maxDistance: number) => { position?: Vec3 } | null;
  };

  if (typeof world.raycast !== "function") {
    // Fallback: sample blocks along the ray
    const steps = Math.ceil(dist * 2);
    for (let i = 1; i < steps; i++) {
      const t = (i / steps) * dist;
      const bx = from.x + dx * t;
      const by = from.y + dy * t;
      const bz = from.z + dz * t;
      const block = bot.blockAt(from.offset(dx * t, dy * t, dz * t));
      if (block && block.boundingBox === "block") {
        // ignore if sample is past/inside target hitbox volume
        if (t + 0.3 < dist) return false;
      }
      void bx;
      void by;
      void bz;
    }
    return true;
  }

  // direction as unit vector — mineflayer/prismarine-world expects Vec3-like
  const dir = from.offset(dx, dy, dz).minus(from);
  try {
    const hit = world.raycast(from, dir.normalize ? dir.normalize() : dir, dist - 0.2);
    if (!hit) return true;
    const hitPos = (hit as { position?: Vec3 }).position;
    if (!hitPos) return true;
    return from.distanceTo(hitPos) + 0.25 >= dist;
  } catch {
    return true;
  }
}

function normalizeAngle(a: number): number {
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** D5: step yaw/pitch toward target — no instantaneous 180° snap */
export async function smoothLookAt(
  bot: Bot,
  point: Vec3,
  turnSpeedDegPerTick: number,
  token?: TaskToken
): Promise<void> {
  const maxRad = ((turnSpeedDegPerTick || 30) * Math.PI) / 180;
  const deadline = Date.now() + 2500;

  while (Date.now() < deadline) {
    if (token?.cancelled) throw new Error(token.reason ?? "Look cancelled");

    const from = eyePos(bot);
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const dz = point.z - from.z;
    const ground = Math.sqrt(dx * dx + dz * dz);
    const targetYaw = Math.atan2(-dx, -dz);
    const targetPitch = Math.atan2(dy, ground || 0.001);

    const dyaw = normalizeAngle(targetYaw - bot.entity.yaw);
    const dpitch = targetPitch - bot.entity.pitch;

    if (Math.abs(dyaw) < 0.03 && Math.abs(dpitch) < 0.03) {
      await bot.look(targetYaw, targetPitch, false);
      return;
    }

    const stepYaw = clamp(dyaw, -maxRad, maxRad);
    const stepPitch = clamp(dpitch, -maxRad, maxRad);
    await bot.look(bot.entity.yaw + stepYaw, bot.entity.pitch + stepPitch, false);
    await sleep(50);
  }

  // final settle
  const from = eyePos(bot);
  const dx = point.x - from.x;
  const dy = point.y - from.y;
  const dz = point.z - from.z;
  const ground = Math.sqrt(dx * dx + dz * dz);
  await bot.look(Math.atan2(-dx, -dz), Math.atan2(dy, ground || 0.001), false);
}

export function randomReactionMs(cfg: CombatConfig): number {
  const lo = Math.max(0, cfg.reactionMsMin ?? 150);
  const hi = Math.max(lo, cfg.reactionMsMax ?? 300);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function isModernCombat(bot: Bot): boolean {
  const v = String(bot.version ?? "");
  // 1.8.x classic; 1.9+ attack cooldown
  if (/^1\.8(\.|$)/.test(v)) return false;
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return true; // auto / unknown → modern rules
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > 1) return true;
  return minor >= 9;
}

export type AttackResult =
  | { ok: true }
  | { ok: false; reason: "range" | "los" | "cancelled" | "offline" | "error"; detail?: string };

/**
 * Full realistic melee swing pipeline (D1–D7). Caller handles approach/chase.
 */
export async function tryRealisticAttack(
  bot: Bot,
  entity: Entity,
  cfg: CombatConfig,
  lastSwingAt: { t: number },
  token?: TaskToken
): Promise<AttackResult> {
  if (!bot.entity || token?.cancelled) return { ok: false, reason: "cancelled" };

  // D2
  if (!inMeleeRange(bot, entity, cfg.reach ?? 3)) {
    return { ok: false, reason: "range" };
  }

  // D3
  if (!hasLineOfSight(bot, entity)) {
    return { ok: false, reason: "los", detail: "Line of sight blocked (wall/blocks)" };
  }

  // D1 + D5
  try {
    await smoothLookAt(bot, aimPoint(entity), cfg.turnSpeedDegPerTick ?? 30, token);
  } catch (e) {
    return { ok: false, reason: "cancelled", detail: e instanceof Error ? e.message : String(e) };
  }
  if (token?.cancelled) return { ok: false, reason: "cancelled" };

  // re-check after look (target may have moved)
  if (!inMeleeRange(bot, entity, cfg.reach ?? 3)) return { ok: false, reason: "range" };
  if (!hasLineOfSight(bot, entity)) return { ok: false, reason: "los" };

  // D4 tempo
  const held = bot.heldItem?.name;
  const modern = isModernCombat(bot);
  const cd = cooldownMsForWeapon(held, modern, cfg.cpsCap ?? 8);
  const wait = lastSwingAt.t + cd - Date.now();
  if (wait > 0) await sleep(wait);
  if (token?.cancelled) return { ok: false, reason: "cancelled" };

  // D7 optional jump-crit (human-like, not forced every hit)
  if (cfg.jumpCrit && bot.entity.onGround && Math.random() < 0.35) {
    try {
      bot.setControlState("jump", true);
      await sleep(80);
      bot.setControlState("jump", false);
    } catch {
      /* ignore */
    }
  }

  try {
    bot.attack(entity);
    lastSwingAt.t = Date.now();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

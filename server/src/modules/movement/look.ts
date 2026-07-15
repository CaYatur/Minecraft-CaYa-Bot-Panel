import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";

/**
 * Hareket için yumuşak bakış — force=false (anlık snap anti-cheat flag'i).
 * Tek adım: pathfinder ile yarışmadan her tick küçük açı.
 */

function normalizeAngle(a: number): number {
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function eyeHeight(bot: Bot): number {
  return (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
}

/** Oyuncu / entity yüz hizası (göz) */
export function entityLookPoint(entity: Entity): { x: number; y: number; z: number } {
  const h = entity.height ?? 1.8;
  return {
    x: entity.position.x,
    y: entity.position.y + h * 0.85,
    z: entity.position.z
  };
}

/**
 * Tek adım bakış. turnDegPerTick ~12–22 insanî; >45 AC riski.
 * force asla true değil.
 */
export async function stepLookAt(
  bot: Bot,
  point: { x: number; y: number; z: number },
  turnDegPerTick = 16
): Promise<void> {
  if (!bot.entity) return;
  const maxRad = (Math.max(4, Math.min(40, turnDegPerTick)) * Math.PI) / 180;
  const from = bot.entity.position.offset(0, eyeHeight(bot), 0);
  const dx = point.x - from.x;
  const dy = point.y - from.y;
  const dz = point.z - from.z;
  const ground = Math.sqrt(dx * dx + dz * dz) || 0.001;
  const targetYaw = Math.atan2(-dx, -dz);
  const targetPitch = clamp(Math.atan2(dy, ground), -1.5, 1.5);

  const dyaw = normalizeAngle(targetYaw - bot.entity.yaw);
  const dpitch = targetPitch - bot.entity.pitch;

  if (Math.abs(dyaw) < 0.02 && Math.abs(dpitch) < 0.02) {
    // küçük jitter yok — settle
    await bot.look(targetYaw, targetPitch, false);
    return;
  }

  const stepYaw = clamp(dyaw, -maxRad, maxRad);
  const stepPitch = clamp(dpitch, -maxRad * 0.85, maxRad * 0.85);
  await bot.look(bot.entity.yaw + stepYaw, bot.entity.pitch + stepPitch, false);
}

/** Birkaç adımda hedefe bak (takip döngüsü / goto bitişi) */
export async function easeLookAt(
  bot: Bot,
  point: { x: number; y: number; z: number },
  turnDegPerTick = 16,
  maxSteps = 12
): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    const before = bot.entity.yaw;
    await stepLookAt(bot, point, turnDegPerTick);
    const dyaw = Math.abs(normalizeAngle(bot.entity.yaw - before));
    if (dyaw < 0.025 && Math.abs(bot.entity.pitch) < 1.6) {
      // check remaining
      const from = bot.entity.position.offset(0, eyeHeight(bot), 0);
      const dx = point.x - from.x;
      const dz = point.z - from.z;
      const targetYaw = Math.atan2(-dx, -dz);
      if (Math.abs(normalizeAngle(targetYaw - bot.entity.yaw)) < 0.05) return;
    }
    await sleep(45 + Math.floor(Math.random() * 25));
  }
}

export async function stepLookAtEntity(bot: Bot, entity: Entity, turnDeg = 16): Promise<void> {
  await stepLookAt(bot, entityLookPoint(entity), turnDeg);
}

/** Hareket yönüne bak (velocity veya hedef nokta) — goto insanîleşmesi */
export async function stepLookAlongMotion(
  bot: Bot,
  fallback: { x: number; y: number; z: number } | null,
  turnDeg = 14
): Promise<void> {
  if (!bot.entity) return;
  const v = bot.entity.velocity;
  const speed = Math.sqrt(v.x * v.x + v.z * v.z);
  if (speed > 0.08) {
    const p = bot.entity.position;
    await stepLookAt(
      bot,
      {
        x: p.x + v.x * 4,
        y: p.y + eyeHeight(bot) + v.y * 2,
        z: p.z + v.z * 4
      },
      turnDeg
    );
    return;
  }
  if (fallback) {
    await stepLookAt(bot, { x: fallback.x, y: fallback.y + 1.2, z: fallback.z }, turnDeg);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type { Vec3 };

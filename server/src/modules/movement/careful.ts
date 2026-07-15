import type { Bot } from "mineflayer";
import { v3 } from "../build/vec3util";

/**
 * Dikkatli hareket: zemin / basamak / boşluk / merdiven tarar.
 * Sprint ve erken atlamayı engellemek için kullanılır.
 */

export type CareLevel = "flat" | "careful" | "hazard";

function blockName(bot: Bot, x: number, y: number, z: number): string {
  const b = bot.blockAt(v3(x, y, z));
  return b?.name?.replace(/^minecraft:/, "") ?? "air";
}

function isAirishName(n: string): boolean {
  return (
    n === "air" ||
    n === "cave_air" ||
    n === "void_air" ||
    n === "light" ||
    n === "short_grass" ||
    n === "tall_grass" ||
    n === "grass" ||
    n.includes("flower") ||
    n.endsWith("_carpet") ||
    n === "snow"
  );
}

function isSolidCell(bot: Bot, x: number, y: number, z: number): boolean {
  const n = blockName(bot, x, y, z);
  if (isAirishName(n) || n === "water" || n === "lava" || n === "bubble_column") return false;
  if (n === "ladder" || n.includes("vine") || n === "scaffolding") return true;
  const b = bot.blockAt(v3(x, y, z));
  if (b?.boundingBox && b.boundingBox !== "block") return false;
  return true;
}

function isClimbable(bot: Bot, x: number, y: number, z: number): boolean {
  const n = blockName(bot, x, y, z);
  return n === "ladder" || n.includes("vine") || n === "scaffolding";
}

function isPassable(bot: Bot, x: number, y: number, z: number): boolean {
  return !isSolidCell(bot, x, y, z) || isClimbable(bot, x, y, z);
}

/**
 * Bakış yönünde 1–2 adım tarar.
 * - flat: sprint OK
 * - careful: basamak / dar yer / merdiven — yürü, sprint yok
 * - hazard: boşluk / düşme riski — yavaş, sprint yok
 */
export function assessTerrainCare(bot: Bot): CareLevel {
  if (!bot.entity) return "careful";
  const p = bot.entity.position;
  const yaw = bot.entity.yaw;
  // mineflayer: yaw 0 = south (+Z), pathfinder ile aynı
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const feetY = Math.floor(p.y + 0.01);
  const px = p.x;
  const pz = p.z;

  let level: CareLevel = "flat";

  for (const dist of [0.8, 1.15, 1.55, 2.1]) {
    const sx = Math.floor(px + fx * dist);
    const sz = Math.floor(pz + fz * dist);

    // merdiven
    if (
      isClimbable(bot, sx, feetY, sz) ||
      isClimbable(bot, sx, feetY + 1, sz) ||
      isClimbable(bot, Math.floor(px), feetY, Math.floor(pz))
    ) {
      return "careful";
    }

    // 1 blok yukarı basamak (ayak hizası solid, üstü boş)
    if (
      isSolidCell(bot, sx, feetY, sz) &&
      isPassable(bot, sx, feetY + 1, sz) &&
      isPassable(bot, sx, feetY + 2, sz)
    ) {
      level = "careful";
      continue;
    }

    // ayak altı yok → boşluk / düşme
    const groundHere = isSolidCell(bot, sx, feetY - 1, sz);
    const groundDown2 = isSolidCell(bot, sx, feetY - 2, sz);
    const groundDown3 = isSolidCell(bot, sx, feetY - 3, sz);

    if (!groundHere) {
      // 1–2 blok iniş: careful; 3+: hazard
      if (!groundDown2 && !groundDown3) {
        // önde platform var mı (gap jump)
        const sx2 = Math.floor(px + fx * (dist + 1.0));
        const sz2 = Math.floor(pz + fz * (dist + 1.0));
        if (isSolidCell(bot, sx2, feetY - 1, sz2) || isSolidCell(bot, sx2, feetY, sz2)) {
          return "hazard"; // gap — erken sprint jump yapmasın
        }
        return "hazard";
      }
      if (!groundDown2) {
        level = level === "hazard" ? "hazard" : "careful";
      } else {
        level = "careful";
      }
    }

    // dar tavan / engel
    if (!isPassable(bot, sx, feetY + 1, sz) && isPassable(bot, sx, feetY, sz)) {
      level = "careful";
    }
  }

  // yanlarda dar koridor değilse flat kalır
  return level;
}

/** Pathfinder sprint açılsın mı? (flat dışı hayır) */
export function shouldAllowSprintForCare(care: CareLevel, configSprint: boolean): boolean {
  if (!configSprint) return false;
  return care === "flat";
}

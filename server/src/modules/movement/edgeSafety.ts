import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import type { MovementConfig } from "../../types";
import { executeGapJump } from "./parkour";
import { v3 } from "../build/vec3util";

/**
 * Uçurum / boşluk güvenliği:
 * - Takip ve goto sırasında önündeki düşüşü önceden gör
 * - Mümkünse 2–3 blok parkour atla
 * - Kısa boşlukta bilinçli köprü (1 blok) — panik düşüş sonrası kule değil
 * - Hiçbiri yoksa dur / kenardan geri çek
 *
 * Düştükten sonra toparlanma (MLG / scaffold) ayrı güvenlik ağı olarak kalır.
 */

export type SafetyAction = "ok" | "jumped" | "bridged" | "backed" | "stopped";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cfg(instance: BotInstance): MovementConfig {
  return instance.config.movement;
}

function isAirish(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return true;
  const n = b.name.replace(/^minecraft:/, "");
  return (
    n === "air" ||
    n === "cave_air" ||
    n === "void_air" ||
    n === "light" ||
    n === "water" ||
    n === "lava" ||
    n === "short_grass" ||
    n === "tall_grass" ||
    n === "snow"
  );
}

function isSolid(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return false;
  const n = b.name.replace(/^minecraft:/, "");
  if (isAirish(bot, x, y, z)) return false;
  if (n === "ladder" || n.includes("vine") || n === "scaffolding") return true; // tırmanılabilir
  if (b.boundingBox && b.boundingBox !== "block") return false;
  return true;
}

/** Ayak altından aşağı kaç blok boş? */
function dropDepth(bot: Bot, x: number, y: number, z: number, maxCheck = 12): number {
  // y = standY (ayak hizası); zemin y-1
  for (let d = 1; d <= maxCheck; d++) {
    if (isSolid(bot, x, y - d, z)) return d - 1; // d-1 air under feet cell before solid
  }
  return maxCheck;
}

/**
 * Hareket yönünde (bakış veya velocity) ön hücreleri tara.
 */
export function scanEdgeAhead(
  bot: Bot,
  maxSafeDrop: number
): {
  danger: boolean;
  depth: number;
  /** ön hücre (ayak hizası) */
  front: { x: number; y: number; z: number };
  /** atlanabilir iniş */
  landing: { x: number; y: number; z: number; gap: number } | null;
  /** 1 blok köprü için boş hücre (ön ayak altı) */
  bridgeCell: { x: number; y: number; z: number } | null;
} {
  const p = bot.entity.position;
  const yaw = bot.entity.yaw;
  // mineflayer: yaw 0 = +z
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const feetY = Math.floor(p.y);
  const cx = Math.floor(p.x);
  const cz = Math.floor(p.z);

  // 1–3 adım öne bak
  let worstDepth = 0;
  let front = { x: cx, y: feetY, z: cz };
  let bridgeCell: { x: number; y: number; z: number } | null = null;
  let landing: { x: number; y: number; z: number; gap: number } | null = null;

  for (let step = 1; step <= 3; step++) {
    const sx = Math.floor(p.x + fx * step + 0.01);
    const sz = Math.floor(p.z + fz * step + 0.01);
    // ayak hizasında zemin yoksa drop
    const depth = dropDepth(bot, sx, feetY, sz);
    if (depth > worstDepth) {
      worstDepth = depth;
      front = { x: sx, y: feetY, z: sz };
    }
    // 1 adım önde tek boşluk + sonra solid = gap jump adayı
    if (step === 1 && depth > maxSafeDrop) {
      bridgeCell = { x: sx, y: feetY - 1, z: sz }; // altına blok
    }
    // 2–4 adımda solid iniş
    if (step >= 2 && depth === 0 && isSolid(bot, sx, feetY - 1, sz)) {
      // aradaki adımlar boş mu?
      let gapOk = true;
      let gapCount = 0;
      for (let t = 1; t < step; t++) {
        const mx = Math.floor(p.x + fx * t);
        const mz = Math.floor(p.z + fz * t);
        const md = dropDepth(bot, mx, feetY, mz);
        if (md <= maxSafeDrop && isSolid(bot, mx, feetY - 1, mz)) {
          gapOk = false;
          break;
        }
        gapCount++;
      }
      if (gapOk && gapCount >= 1) {
        landing = { x: sx, y: feetY, z: sz, gap: Math.min(4, Math.max(2, gapCount + 1)) };
      }
    }
  }

  // 1 blok ince yol: yanlar da boş ve ön tehlikeli
  const danger = worstDepth > maxSafeDrop;

  return { danger, depth: worstDepth, front, landing, bridgeCell: danger ? bridgeCell : null };
}

async function stepBackFromEdge(bot: Bot): Promise<void> {
  try {
    bot.setControlState("forward", false);
    bot.setControlState("sprint", false);
    bot.setControlState("back", true);
    await sleep(180);
    bot.setControlState("back", false);
    await sleep(40);
  } catch {
    try {
      bot.setControlState("back", false);
    } catch {
      /* */
    }
  }
}

async function placeBridgeBlock(
  instance: BotInstance,
  cell: { x: number; y: number; z: number }
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot) return false;
  const preferred = instance.config.movement.scaffoldBlocks ?? ["dirt", "cobblestone", "netherrack"];
  const items = bot.inventory.items();
  let item = null as (typeof items)[0] | null;
  for (const name of preferred) {
    item = items.find((i) => i.name === name) ?? null;
    if (item) break;
  }
  if (!item) {
    item = items.find((i) => i.name === "dirt" || i.name === "cobblestone" || i.name.endsWith("_planks")) ?? null;
  }
  if (!item) return false;

  // yan referans bul
  const faces: [number, number, number][] = [
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1]
  ];
  try {
    await bot.equip(item, "hand");
  } catch {
    return false;
  }

  for (const [fx, fy, fz] of faces) {
    const ref = bot.blockAt(v3(cell.x + fx, cell.y + fy, cell.z + fz));
    if (!ref || isAirish(bot, cell.x + fx, cell.y + fy, cell.z + fz)) continue;
    if (!isSolid(bot, cell.x + fx, cell.y + fy, cell.z + fz) && ref.boundingBox !== "block") continue;
    try {
      await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(ref, v3(-fx, -fy, -fz));
      await sleep(50);
      // koyuldu mu?
      if (isSolid(bot, cell.x, cell.y, cell.z)) {
        instance.getLogger().info("Kenar köprüsü", `${cell.x},${cell.y},${cell.z} · ${item.name}`);
        return true;
      }
    } catch {
      continue;
    }
  }

  // zıplayarak ayak altı köprü (sneak bridge benzeri)
  try {
    const below = bot.blockAt(v3(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y) - 1, Math.floor(bot.entity.position.z)));
    if (below && isSolid(bot, below.position.x, below.position.y, below.position.z)) {
      await bot.look(bot.entity.yaw, 1.2, true);
      bot.setControlState("sneak", true);
      bot.setControlState("forward", true);
      await sleep(80);
      try {
        await bot.placeBlock(below, v3(0, 1, 0));
      } catch {
        /* */
      }
      bot.setControlState("forward", false);
      bot.setControlState("sneak", false);
      if (isSolid(bot, cell.x, cell.y, cell.z) || isSolid(bot, cell.x, cell.y + 1, cell.z)) return true;
    }
  } catch {
    try {
      bot.setControlState("sneak", false);
      bot.setControlState("forward", false);
    } catch {
      /* */
    }
  }
  return false;
}

/**
 * Her hareket tick'inde çağır: tehlike varsa atla / köprü / geri çek.
 * pathfinder goal'u geçici durdurabilir.
 */
export async function handleEdgeSafety(
  instance: BotInstance,
  token: TaskToken,
  opts?: { pausePath?: boolean }
): Promise<SafetyAction> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return "ok";
  if (token.cancelled) return "stopped";

  const m = cfg(instance);
  if (m.edgeSafety === false) return "ok";

  const maxSafeDrop = Math.max(1, Math.min(4, m.maxSafeDrop ?? 2));
  const preferParkour = m.preferParkourOverBridge !== false;
  const canBridge = m.bridgeGaps !== false;
  const maxGap = Math.min(4, Math.max(2, m.parkourMaxGap ?? 3));

  // zaten havadaysa (düşüyor) — burada panik köprü değil, MLG devreye girer
  if (!bot.entity.onGround && (bot.entity.velocity?.y ?? 0) < -0.4) {
    return "ok";
  }

  const scan = scanEdgeAhead(bot, maxSafeDrop);
  if (!scan.danger) return "ok";

  // pathfinder'ı kısa kes — uçuruma yürümesin
  if (opts?.pausePath !== false) {
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* */
    }
  }

  // 1) parkour atlama mümkünse
  if (preferParkour && m.allowParkour !== false && scan.landing && scan.landing.gap <= maxGap) {
    const ok = await executeGapJump(
      instance,
      { x: scan.landing.x, y: scan.landing.y, z: scan.landing.z },
      scan.landing.gap,
      token
    );
    if (ok) return "jumped";
  }

  // 2) kısa boşluk — 1 blok köprü (bilinçli, düştükten sonra değil)
  if (canBridge && scan.depth >= maxSafeDrop && scan.depth <= maxSafeDrop + 3 && scan.bridgeCell) {
    // sadece sığ-orta boşluk / tek adım; uçurumda köprü spam yok
    if (scan.depth <= 6) {
      const ok = await placeBridgeBlock(instance, scan.bridgeCell);
      if (ok) return "bridged";
    }
  }

  // 3) güvenli değil — geri çek, bu yoldan gitme
  await stepBackFromEdge(bot);
  instance.getLogger().info(
    "Uçurum güvenliği",
    `ön drop≈${scan.depth} · geri çekildi (parkur/köprü yok)`
  );
  return "backed";
}

/**
 * Pathfinder maxDrop: takipte düşük tut → uçurumdan path seçmesin.
 */
export function safeMaxDropForPath(cfg: MovementConfig, mode: "follow" | "goto" | "parkour"): number {
  const safe = Math.max(1, Math.min(4, cfg.maxSafeDrop ?? 2));
  if (mode === "parkour") return Math.max(safe, Math.min(8, (cfg.parkourMaxGap ?? 3) + 2));
  if (mode === "follow") return safe; // takip: agresif düşme yok
  return Math.max(safe, Math.min(4, cfg.maxDrop ?? 3));
}

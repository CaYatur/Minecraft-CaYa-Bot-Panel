import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import type { MovementConfig } from "../../types";
import { executeGapJump } from "./parkour";
import { v3 } from "../build/vec3util";

/**
 * Uçurum güvenliği v3 — konservatif:
 * - 1 blok yukarı / 1 aşağı / düz yürüyüş = ASLA karışma
 * - drop 1–3 = pathfinder işi (maxDrop ile uyumlu); spam geri çekme YOK
 * - sadece derin void (varsayılan drop≥4) veya net uçurumda devreye gir
 * - backed sonrası cooldown — sonsuz log/geri çekme döngüsü yok
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
    n === "bubble_column" ||
    n === "short_grass" ||
    n === "tall_grass" ||
    n === "grass" ||
    n === "fern" ||
    n === "dead_bush" ||
    n === "snow" ||
    n.endsWith("_carpet") ||
    n.includes("flower") ||
    n === "torch" ||
    n.includes("sign")
  );
}

function isSolid(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return false;
  if (isAirish(bot, x, y, z)) return false;
  const n = b.name.replace(/^minecraft:/, "");
  if (n === "ladder" || n.includes("vine") || n === "scaffolding") return true;
  if (b.boundingBox && b.boundingBox !== "block") return false;
  return true;
}

/**
 * Pathfinder'ın normalde yaptığı şeyler — güvenli say:
 * - aynı seviye yürü
 * - 1 blok yukarı zıpla
 * - 1–2 blok aşağı in (maxDrop ile uyumlu)
 */
function isNormalStep(bot: Bot, sx: number, feetY: number, sz: number, maxSafeDrop: number): boolean {
  // düz
  if (isSolid(bot, sx, feetY - 1, sz) && isAirish(bot, sx, feetY, sz) && isAirish(bot, sx, feetY + 1, sz)) {
    return true;
  }
  // 1 up
  if (isSolid(bot, sx, feetY, sz) && isAirish(bot, sx, feetY + 1, sz) && isAirish(bot, sx, feetY + 2, sz)) {
    return true;
  }
  // 1–2 down (pathfinder maxDrop)
  for (let down = 1; down <= Math.max(2, maxSafeDrop); down++) {
    if (
      isSolid(bot, sx, feetY - 1 - down, sz) &&
      isAirish(bot, sx, feetY - down, sz) &&
      isAirish(bot, sx, feetY, sz) &&
      isAirish(bot, sx, feetY + 1, sz)
    ) {
      return true;
    }
  }
  // merdiven / scaffolding
  for (const dy of [0, -1, 1]) {
    const b = bot.blockAt(v3(sx, feetY + dy, sz));
    const n = b?.name?.replace(/^minecraft:/, "") ?? "";
    if (n === "ladder" || n.includes("vine") || n === "scaffolding") return true;
  }
  return false;
}

/** Gerçek uçurum derinliği — normal basamak 0 */
function cliffDepth(bot: Bot, sx: number, feetY: number, sz: number, maxCheck = 24): number {
  if (isNormalStep(bot, sx, feetY, sz, 3)) return 0;
  for (let d = 1; d <= maxCheck; d++) {
    // solid whose top is standable at feetY - d
    if (isSolid(bot, sx, feetY - d, sz) && isAirish(bot, sx, feetY - d + 1, sz)) {
      return d - 1;
    }
  }
  return maxCheck;
}

export function scanEdgeAhead(
  bot: Bot,
  maxSafeDrop: number
): {
  danger: boolean;
  depth: number;
  front: { x: number; y: number; z: number };
  landing: { x: number; y: number; z: number; gap: number } | null;
  bridgeCell: { x: number; y: number; z: number } | null;
} {
  if (!bot.entity) {
    return { danger: false, depth: 0, front: { x: 0, y: 0, z: 0 }, landing: null, bridgeCell: null };
  }

  const p = bot.entity.position;
  const yaw = bot.entity.yaw;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const feetY = Math.floor(p.y + 0.05);
  const cx = Math.floor(p.x);
  const cz = Math.floor(p.z);

  // SADECE 1 adım ötesi — tehlike kararı (2–3 adım parkour için)
  const s1x = Math.floor(p.x + fx * 1.05);
  const s1z = Math.floor(p.z + fz * 1.05);
  const front = { x: s1x, y: feetY, z: s1z };

  // normal basamak → danger yok
  if (isNormalStep(bot, s1x, feetY, s1z, maxSafeDrop)) {
    return { danger: false, depth: 0, front, landing: null, bridgeCell: null };
  }

  const depth = cliffDepth(bot, s1x, feetY, s1z);
  // pathfinder zaten maxDrop ile 1–3 inebilir — biz sadece daha derin void'da
  const dangerThreshold = Math.max(maxSafeDrop + 1, 4); // en az drop≥4
  const danger = depth >= dangerThreshold;

  let landing: { x: number; y: number; z: number; gap: number } | null = null;
  let bridgeCell: { x: number; y: number; z: number } | null = null;

  if (danger) {
    bridgeCell = { x: s1x, y: feetY - 1, z: s1z };
    // 2–4 adımda iniş platformu
    for (let step = 2; step <= 4; step++) {
      const sx = Math.floor(p.x + fx * (step + 0.1));
      const sz = Math.floor(p.z + fz * (step + 0.1));
      if (!isNormalStep(bot, sx, feetY, sz, maxSafeDrop) && !isSolid(bot, sx, feetY - 1, sz)) continue;
      let pure = true;
      for (let t = 1; t < step; t++) {
        const mx = Math.floor(p.x + fx * (t + 0.1));
        const mz = Math.floor(p.z + fz * (t + 0.1));
        if (isNormalStep(bot, mx, feetY, mz, maxSafeDrop)) {
          pure = false;
          break;
        }
      }
      if (pure) {
        landing = { x: sx, y: feetY, z: sz, gap: Math.min(4, Math.max(2, step)) };
        break;
      }
    }
  }

  return { danger, depth, front, landing, bridgeCell: danger ? bridgeCell : null };
}

async function stepBackFromEdge(bot: Bot): Promise<void> {
  try {
    bot.setControlState("forward", false);
    bot.setControlState("sprint", false);
    bot.setControlState("jump", false);
    bot.setControlState("back", true);
    await sleep(140);
    bot.setControlState("back", false);
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
  // hücre zaten doluysa OK
  if (isSolid(bot, cell.x, cell.y, cell.z)) return true;

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
    if (!ref || !isSolid(bot, cell.x + fx, cell.y + fy, cell.z + fz)) continue;
    try {
      await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(ref, v3(-fx, -fy, -fz));
      await sleep(40);
      if (isSolid(bot, cell.x, cell.y, cell.z)) {
        instance.getLogger().info("Kenar köprüsü", `${cell.x},${cell.y},${cell.z}`);
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

let lastSafetyAt = 0;
let lastBackAt = 0;
let lastLogAt = 0;
/** backed sonrası bu süre path'e karışma */
const BACK_COOLDOWN_MS = 2800;
const SCAN_COOLDOWN_MS = 400;

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

  const now = Date.now();
  if (now - lastSafetyAt < SCAN_COOLDOWN_MS) return "ok";
  // az önce geri çekildiyse spam yok — pathfinder devam etsin
  if (now - lastBackAt < BACK_COOLDOWN_MS) return "ok";

  if (!bot.entity.onGround) return "ok";
  if ((bot.entity.velocity?.y ?? 0) > 0.08) return "ok"; // zıplıyor (1-up)

  // maxSafeDrop config: 1–4; tehlike eşiği en az 4 (3 blok drop pathfinder'a bırak)
  const maxSafeDrop = Math.max(1, Math.min(4, m.maxSafeDrop ?? 3));
  const preferParkour = m.preferParkourOverBridge !== false;
  const canBridge = m.bridgeGaps !== false;
  const maxGap = Math.min(4, Math.max(2, m.parkourMaxGap ?? 3));

  const scan = scanEdgeAhead(bot, maxSafeDrop);
  if (!scan.danger) return "ok";

  lastSafetyAt = now;

  if (opts?.pausePath !== false) {
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* */
    }
  }

  // 1) parkour — gerçek boşlukta
  if (preferParkour && m.allowParkour !== false && scan.landing && scan.landing.gap <= maxGap) {
    const ok = await executeGapJump(
      instance,
      { x: scan.landing.x, y: scan.landing.y, z: scan.landing.z },
      scan.landing.gap,
      token
    );
    if (ok) return "jumped";
  }

  // 2) köprü — sadece drop 4–6 ve bridge açık
  if (canBridge && scan.bridgeCell && scan.depth >= 4 && scan.depth <= 6) {
    const ok = await placeBridgeBlock(instance, scan.bridgeCell);
    if (ok) return "bridged";
  }

  // 3) geri çek + cooldown (spam engel)
  await stepBackFromEdge(bot);
  lastBackAt = Date.now();
  if (Date.now() - lastLogAt > 3000) {
    lastLogAt = Date.now();
    instance.getLogger().info("Uçurum güvenliği", `ön drop≈${scan.depth} · geri çekildi · 2.8s bekle`);
  }
  return "backed";
}

/**
 * Eski pathfinder davranışı: maxDrop config (3).
 * Edge safety derin void'u ayrıca yakalar — maxDrop'u 2'ye kilitleme.
 */
export function safeMaxDropForPath(cfg: MovementConfig, mode: "follow" | "goto" | "parkour"): number {
  const configured = Math.max(1, Math.min(6, cfg.maxDrop ?? 3));
  if (mode === "parkour") {
    return Math.max(configured, Math.min(8, (cfg.parkourMaxGap ?? 3) + 2));
  }
  // follow/goto: eskisi gibi 3 (humanize üst 4)
  return Math.min(4, configured);
}

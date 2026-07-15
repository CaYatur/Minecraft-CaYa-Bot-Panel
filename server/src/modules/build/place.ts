import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";
import { goals } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import { ensureMovement } from "../movement";
import { equipBestToolForBlock, pickScaffoldItem, type ScaffoldTracker } from "./scaffold";
import { v3 } from "./vec3util";

const FACES: [number, number, number][] = [
  [0, -1, 0],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1]
];

/** Yerleştirme menzili — bu içinde pathfinder ÇAĞIRMA */
const PLACE_REACH = 4.2;
/** Path hedefe yaklaşma yarıçapı */
const PATH_RANGE = 3.2;
/** Path zaman aşımı (ms) — 45s eski, takılıyordu */
const PATH_TIMEOUT_MS = 10_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function dist3(bot: Bot, x: number, y: number, z: number): number {
  const p = bot.entity.position;
  const dx = p.x - x;
  const dy = p.y - y;
  const dz = p.z - z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Sadece gerekirse pathfinder. Zaten yakındaysa no-op.
 * Eski kod her blokta GoalNear + 200ms poll + 45s timeout → yavaş ve takılma.
 */
async function pathNear(instance: BotInstance, x: number, y: number, z: number, range: number, token: TaskToken) {
  const bot = ensureMovement(instance);
  if (dist3(bot, x, y, z) <= range + 0.5) return;

  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
  const t0 = Date.now();
  let noPath = false;
  const onPath = (r: { status?: string }) => {
    if (r?.status === "noPath" || r?.status === "timeout") noPath = true;
  };
  bot.on("path_update", onPath);
  try {
    while (!token.cancelled && Date.now() - t0 < PATH_TIMEOUT_MS) {
      if (noPath) break;
      if (dist3(bot, x, y, z) <= range + 0.55) break;
      // hareket yoksa erken çık (takılı path)
      if (Date.now() - t0 > 2500 && dist3(bot, x, y, z) > range + 2) {
        // hâlâ uzak — biraz daha bekle; 6s sonra bırak
        if (Date.now() - t0 > 6000) break;
      }
      await sleep(80);
    }
  } finally {
    bot.removeListener("path_update", onPath);
    try {
      bot.pathfinder.setGoal(null);
    } catch {
      /* */
    }
  }
  if (token.cancelled) throw new Error(token.reason ?? "iptal");
}

/** Şema blok adı → envanter item adı (sıvı / özel) */
export function itemNameForBlock(blockName: string): string[] {
  const n = blockName.replace(/^minecraft:/, "");
  if (n === "water" || n === "flowing_water") return ["water_bucket"];
  if (n === "lava" || n === "flowing_lava") return ["lava_bucket"];
  if (n === "powder_snow") return ["powder_snow_bucket"];
  if (n === "redstone_wire") return ["redstone"];
  if (n === "tripwire") return ["string"];
  if (n.endsWith("_wall_sign") || n.endsWith("_sign")) {
    const base = n.replace(/_wall_sign$/, "_sign").replace(/_hanging_sign$/, "_sign");
    return [base, n];
  }
  return [n];
}

/**
 * Mutlak (x,y,z) konumuna named block yerleştir.
 */
export async function placeBlockAt(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  blockName: string,
  token: TaskToken,
  scaffolds: ScaffoldTracker,
  opts?: { retries?: number }
): Promise<"placed" | "skipped" | "failed"> {
  const retries = Math.max(1, opts?.retries ?? 1);
  let last: "placed" | "skipped" | "failed" = "failed";
  for (let attempt = 0; attempt < retries; attempt++) {
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    last = await placeBlockAtOnce(instance, x, y, z, blockName, token, scaffolds);
    if (last === "placed" || last === "skipped") return last;
    if (attempt + 1 < retries) await sleep(80 + attempt * 60);
  }
  return last;
}

async function placeBlockAtOnce(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  blockName: string,
  token: TaskToken,
  scaffolds: ScaffoldTracker
): Promise<"placed" | "skipped" | "failed"> {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot çevrimdışı");
  const target = v3(Math.floor(x), Math.floor(y), Math.floor(z));
  const name = String(blockName).replace(/^minecraft:/, "");

  let existing = bot.blockAt(target);
  if (existing && (existing.name === name || namesMatch(existing.name, name))) return "skipped";

  // Yanlış blok (başka oyuncu / eski yapı / hatalı path) → kır, sonra doğru koy
  if (existing && !isReplaceableBlock(existing.name) && !namesMatch(existing.name, name)) {
    const cleared = await clearBlockAt(instance, target, token);
    if (!cleared) return "failed";
    existing = bot.blockAt(target);
    // hâlâ dolu ve yanlışsa
    if (existing && !isReplaceableBlock(existing.name) && !namesMatch(existing.name, name)) {
      return "failed";
    }
  }

  const itemNames = itemNameForBlock(name);
  const item = bot.inventory.items().find((i) => itemNames.includes(i.name));
  if (!item) return "failed";

  const tx = target.x + 0.5;
  const ty = target.y + 0.5;
  const tz = target.z + 0.5;

  // sıvı: kova
  if (
    item.name.endsWith("_bucket") &&
    (name === "water" || name === "lava" || name === "powder_snow" || name.includes("water") || name.includes("lava"))
  ) {
    if (dist3(bot, tx, ty, tz) > PLACE_REACH) {
      await pathNear(instance, tx, target.y, tz, PATH_RANGE, token);
    }
    try {
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      await bot.lookAt(target.offset(0.5, 0.2, 0.5), true);
      bot.activateItem(false);
      await sleep(50);
      try {
        bot.deactivateItem();
      } catch {
        /* */
      }
      const after = bot.blockAt(target);
      if (
        after &&
        (after.name.includes(name.split("_")[0]!) ||
          after.name === name ||
          after.name.includes("water") ||
          after.name.includes("lava"))
      ) {
        scaffolds.protectStructure(target.x, target.y, target.z);
        return "placed";
      }
      return "failed";
    } catch {
      return "failed";
    }
  }

  // sadece uzaktaysa yürü
  if (dist3(bot, tx, ty, tz) > PLACE_REACH) {
    await pathNear(instance, tx, target.y, tz, PATH_RANGE, token);
  }

  let ref = findReference(bot, target);
  if (!ref) {
    await ensureSupport(instance, target, token, scaffolds);
    ref = findReference(bot, target);
  }
  if (!ref) return "failed";

  const eyeH = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
  const eyeY = bot.entity.position.y + eyeH;
  if (target.y - eyeY > 2.8) {
    await climbWithScaffold(instance, target.y - 1, token, scaffolds);
  }

  try {
    if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
  } catch {
    return "failed";
  }

  ref = findReference(bot, target) ?? ref;
  try {
    await bot.lookAt(ref.block.position.offset(0.5, 0.5, 0.5), true);
    await bot.placeBlock(ref.block, ref.face);
    // kısa doğrulama (200ms bekleme kaldırıldı)
    await sleep(40);
    let after = bot.blockAt(target);
    if (after && (after.name === name || after.name === item.name || namesMatch(after.name, name))) {
      scaffolds.protectStructure(target.x, target.y, target.z);
      return "placed";
    }
    await sleep(80);
    after = bot.blockAt(target);
    if (after && (after.name === name || after.name === item.name || namesMatch(after.name, name))) {
      scaffolds.protectStructure(target.x, target.y, target.z);
      return "placed";
    }
    // yerleştirme paket gecikmesi — block yok ama hata da yok; komşu ref'ten tekrar deneme yok
    return "failed";
  } catch {
    return "failed";
  }
}

function namesMatch(a: string, b: string): boolean {
  const x = a.replace(/^minecraft:/, "");
  const y = b.replace(/^minecraft:/, "");
  return x === y || x.replace(/_block$/, "") === y.replace(/_block$/, "");
}

function isReplaceableBlock(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "air" ||
    n === "cave_air" ||
    n === "void_air" ||
    n === "water" ||
    n === "lava" ||
    n === "flowing_water" ||
    n === "flowing_lava" ||
    n === "bubble_column" ||
    n === "short_grass" ||
    n === "tall_grass" ||
    n === "grass" ||
    n === "fern" ||
    n === "large_fern" ||
    n === "dead_bush" ||
    n === "snow" ||
    n.includes("fire")
  );
}

function isUnbreakable(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "bedrock" ||
    n === "barrier" ||
    n === "command_block" ||
    n === "chain_command_block" ||
    n === "repeating_command_block" ||
    n === "structure_block" ||
    n === "jigsaw" ||
    n === "end_portal" ||
    n === "end_portal_frame" ||
    n === "nether_portal"
  );
}

/**
 * Hedefteki yanlış bloğu kır (kazma/kürek ile).
 * Başka oyuncunun koyduğu / hatalı path / eski blok.
 */
async function clearBlockAt(
  instance: BotInstance,
  target: Vec3,
  token: TaskToken
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot) return false;
  const b = bot.blockAt(target);
  if (!b || isReplaceableBlock(b.name)) return true;
  if (isUnbreakable(b.name)) return false;

  // ayak altını kırma — önce kaymaya çalış
  const feet = bot.entity.position;
  const onFeet =
    Math.floor(feet.x) === target.x && Math.floor(feet.y) === target.y && Math.floor(feet.z) === target.z;
  if (onFeet) {
    try {
      bot.setControlState("back", true);
      await sleep(200);
      bot.setControlState("back", false);
      await sleep(50);
    } catch {
      /* */
    }
    const feet2 = bot.entity.position;
    if (Math.floor(feet2.x) === target.x && Math.floor(feet2.y) === target.y && Math.floor(feet2.z) === target.z) {
      return false;
    }
  }

  const tx = target.x + 0.5;
  const ty = target.y + 0.5;
  const tz = target.z + 0.5;
  if (dist3(bot, tx, ty, tz) > PLACE_REACH) {
    await pathNear(instance, tx, target.y, tz, PATH_RANGE, token);
  }
  if (token.cancelled) throw new Error(token.reason ?? "iptal");

  const live = bot.blockAt(target);
  if (!live || isReplaceableBlock(live.name)) return true;
  if (!bot.canDigBlock(live)) return false;

  try {
    await equipBestToolForBlock(bot, live);
    await bot.lookAt(live.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(live, true);
    await sleep(40);
    const after = bot.blockAt(target);
    return !after || isReplaceableBlock(after.name);
  } catch {
    return false;
  }
}

function findReference(bot: Bot, target: Vec3): { block: Block; face: Vec3 } | null {
  for (const [fx, fy, fz] of FACES) {
    const rp = v3(target.x + fx, target.y + fy, target.z + fz);
    const b = bot.blockAt(rp);
    if (!b || b.name === "air" || b.name === "cave_air" || b.name === "void_air" || b.name === "water" || b.name === "lava") {
      continue;
    }
    const face = v3(-fx, -fy, -fz);
    return { block: b, face };
  }
  return null;
}

async function ensureSupport(
  instance: BotInstance,
  target: Vec3,
  token: TaskToken,
  scaffolds: ScaffoldTracker
) {
  const bot = instance.bot!;
  const under = v3(target.x, target.y - 1, target.z);
  const ub = bot.blockAt(under);
  if (ub && ub.name !== "air" && ub.name !== "cave_air") return;

  const scaffoldName = pickScaffoldItem(bot, instance.config.movement.scaffoldBlocks);
  if (!scaffoldName) return;

  if (dist3(bot, under.x + 0.5, under.y, under.z + 0.5) > PLACE_REACH) {
    await pathNear(instance, under.x + 0.5, under.y, under.z + 0.5, PATH_RANGE, token);
  }
  const item = bot.inventory.items().find((i) => i.name === scaffoldName);
  if (!item) return;

  let ref = findReference(bot, under);
  if (!ref && under.y > -64) {
    await ensureSupport(instance, under, token, scaffolds);
    ref = findReference(bot, under);
  }
  if (!ref) return;
  try {
    if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
    await bot.placeBlock(ref.block, ref.face);
    scaffolds.record(under.x, under.y, under.z, scaffoldName);
    await sleep(40);
  } catch {
    /* */
  }
}

async function climbWithScaffold(
  instance: BotInstance,
  targetFootY: number,
  token: TaskToken,
  scaffolds: ScaffoldTracker
) {
  const bot = instance.bot!;
  const preferred = instance.config.movement.scaffoldBlocks;
  let guard = 0;
  while (!token.cancelled && bot.entity.position.y < targetFootY - 0.5 && guard < 16) {
    guard++;
    const scaffoldName = pickScaffoldItem(bot, preferred);
    if (!scaffoldName) break;
    const item = bot.inventory.items().find((i) => i.name === scaffoldName);
    if (!item) break;

    const fx = Math.floor(bot.entity.position.x);
    const fy = Math.floor(bot.entity.position.y);
    const fz = Math.floor(bot.entity.position.z);
    try {
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      const below = bot.blockAt(v3(fx, fy - 1, fz));
      if (below && below.name !== "air") {
        bot.setControlState("jump", true);
        await sleep(120);
        try {
          await bot.placeBlock(below, v3(0, 1, 0));
          scaffolds.record(fx, fy, fz, scaffoldName);
        } catch {
          /* */
        }
        bot.setControlState("jump", false);
        await sleep(140);
      } else {
        break;
      }
    } catch {
      bot.setControlState("jump", false);
      break;
    }
  }
}

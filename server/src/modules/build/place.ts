import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";
import { goals } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import { ensureMovement } from "../movement";
import { pickScaffoldItem, type ScaffoldTracker } from "./scaffold";
import { v3 } from "./vec3util";

const FACES: [number, number, number][] = [
  [0, -1, 0],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1]
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pathNear(instance: BotInstance, x: number, y: number, z: number, range: number, token: TaskToken) {
  const bot = ensureMovement(instance);
  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
  const t0 = Date.now();
  while (!token.cancelled && Date.now() - t0 < 45_000) {
    const d = bot.entity.position.distanceTo({ x, y, z } as never);
    if (d <= range + 0.6) break;
    await sleep(200);
  }
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }
  if (token.cancelled) throw new Error(token.reason ?? "iptal");
}

/**
 * Mutlak (x,y,z) konumuna named block yerleştir.
 * Gerekirse scaffold kule/basamak koyar ve tracker'a yazar.
 */
export async function placeBlockAt(
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

  const existing = bot.blockAt(target);
  if (existing && existing.name === name) return "skipped";
  if (
    existing &&
    existing.name !== "air" &&
    existing.name !== "cave_air" &&
    existing.name !== "water" &&
    existing.name !== "lava" &&
    existing.name !== name
  ) {
    return "skipped";
  }

  const item = bot.inventory.items().find((i) => i.name === name);
  if (!item) return "failed";

  await pathNear(instance, target.x + 0.5, target.y, target.z + 0.5, 3, token);

  let ref = findReference(bot, target);
  if (!ref) {
    await ensureSupport(instance, target, token, scaffolds);
    ref = findReference(bot, target);
  }
  if (!ref) return "failed";

  const eyeH = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
  const eyeY = bot.entity.position.y + eyeH;
  if (target.y - eyeY > 2.5) {
    await climbWithScaffold(instance, target.y - 1, token, scaffolds);
  }

  try {
    await bot.equip(item, "hand");
  } catch {
    return "failed";
  }

  ref = findReference(bot, target) ?? ref;
  try {
    await bot.lookAt(ref.block.position.offset(0.5, 0.5, 0.5), true);
    await sleep(80);
    await bot.placeBlock(ref.block, ref.face);
    await sleep(120);
    const after = bot.blockAt(target);
    if (after && after.name === name) return "placed";
    await sleep(200);
    const after2 = bot.blockAt(target);
    return after2 && after2.name === name ? "placed" : "failed";
  } catch {
    return "failed";
  }
}

function findReference(bot: Bot, target: Vec3): { block: Block; face: Vec3 } | null {
  for (const [fx, fy, fz] of FACES) {
    const rp = v3(target.x + fx, target.y + fy, target.z + fz);
    const b = bot.blockAt(rp);
    if (!b || b.name === "air" || b.name === "cave_air" || b.name === "water" || b.name === "lava") continue;
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

  await pathNear(instance, under.x + 0.5, under.y, under.z + 0.5, 3, token);
  const item = bot.inventory.items().find((i) => i.name === scaffoldName);
  if (!item) return;

  let ref = findReference(bot, under);
  if (!ref && under.y > -64) {
    await ensureSupport(instance, under, token, scaffolds);
    ref = findReference(bot, under);
  }
  if (!ref) return;
  try {
    await bot.equip(item, "hand");
    await bot.placeBlock(ref.block, ref.face);
    scaffolds.record(under.x, under.y, under.z, scaffoldName);
    await sleep(80);
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
  while (!token.cancelled && bot.entity.position.y < targetFootY - 0.5 && guard < 24) {
    guard++;
    const scaffoldName = pickScaffoldItem(bot, preferred);
    if (!scaffoldName) break;
    const item = bot.inventory.items().find((i) => i.name === scaffoldName);
    if (!item) break;

    const fx = Math.floor(bot.entity.position.x);
    const fy = Math.floor(bot.entity.position.y);
    const fz = Math.floor(bot.entity.position.z);
    try {
      await bot.equip(item, "hand");
      const below = bot.blockAt(v3(fx, fy - 1, fz));
      if (below && below.name !== "air") {
        bot.setControlState("jump", true);
        await sleep(200);
        try {
          await bot.placeBlock(below, v3(0, 1, 0));
          scaffolds.record(fx, fy, fz, scaffoldName);
        } catch {
          /* */
        }
        bot.setControlState("jump", false);
        await sleep(300);
      } else {
        break;
      }
    } catch {
      bot.setControlState("jump", false);
      break;
    }
  }
}

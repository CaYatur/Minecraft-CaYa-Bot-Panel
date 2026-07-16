import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import { sleep } from "./maneuver";
import { fetchFromStorage, scanNearbyStorage } from "./stock";

/**
 * Storage acquisition (compat surface for craft/build):
 * quick nearby scan → ledger-driven withdraw → carried-shulker fallback.
 * Containers are only opened, never broken; contents are marked in the
 * live stock index (and the persistent world memory) instead of hoarded.
 */

interface ContainerItem {
  name: string;
  count: number;
  type: number;
  metadata?: number | null;
}

interface OpenContainer {
  containerItems?: () => ContainerItem[];
  items?: () => ContainerItem[];
  withdraw(type: number, metadata: number | null, count: number): Promise<void>;
  close(): void;
}

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline");
  return bot;
}

function inventoryCount(bot: Bot, names: Set<string>): number {
  return bot.inventory.items().reduce((sum, item) => sum + (names.has(item.name) ? item.count : 0), 0);
}

function containerItems(container: OpenContainer): ContainerItem[] {
  try {
    if (typeof container.containerItems === "function") return container.containerItems();
    if (typeof container.items === "function") return container.items();
  } catch {
    /* window closed / server refused */
  }
  return [];
}

async function openContainer(bot: Bot, block: unknown): Promise<OpenContainer> {
  const api = bot as unknown as { openContainer(block: unknown): Promise<OpenContainer> };
  if (typeof api.openContainer !== "function") throw new Error("openContainer not supported");
  return api.openContainer(block);
}

/**
 * Withdraw `count` of any of `itemNames` from player storage nearby.
 * World chests/barrels/shulkers are only opened; a carried shulker box is
 * temporarily placed on a safe spot and reclaimed afterwards.
 */
export async function withdrawBuildMaterials(
  instance: BotInstance,
  itemNames: string[],
  count: number,
  token: TaskToken,
  onActivity: (label: string) => void = () => {}
): Promise<number> {
  const bot = requireBot(instance);
  const names = new Set(itemNames.map((name) => name.replace(/^minecraft:/, "")));
  const wanted = Math.max(0, Math.floor(count));
  if (!wanted || !names.size) return 0;

  const before = inventoryCount(bot, names);
  const index = instance.build.stock;

  // ledger empty for these names → refresh the neighborhood first
  if (index.stockOf(names) <= 0) {
    try {
      await scanNearbyStorage(instance, index, { radius: 24, maxContainers: 16, budgetMs: 45_000 }, token, onActivity);
    } catch (e) {
      if (token.cancelled) throw e;
      /* scan is best-effort */
    }
  }

  if (index.stockOf(names) > 0) {
    await fetchFromStorage(instance, index, [...names], wanted, token, onActivity);
  }

  // world storage was not enough → look inside carried shulker boxes
  if (inventoryCount(bot, names) - before < wanted) {
    const shulkers = bot.inventory
      .items()
      .filter((item) => item.name === "shulker_box" || item.name.endsWith("_shulker_box"));
    for (const shulker of shulkers) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      if (inventoryCount(bot, names) - before >= wanted) break;
      try {
        onActivity(`Opening carried shulker: ${shulker.name}`);
        await withPortableShulker(instance, shulker.name, token, async (container) => {
          await withdrawMatching(container, names, wanted - (inventoryCount(bot, names) - before));
        });
      } catch (error) {
        instance
          .getLogger()
          .warn("Could not use shulker", error instanceof Error ? error.message : String(error));
      }
    }
  }

  const taken = Math.max(0, inventoryCount(bot, names) - before);
  if (taken > 0) onActivity(`Withdrawn from storage: ${[...names].join("/")} ×${taken}`);
  return taken;
}

async function withdrawMatching(
  container: OpenContainer,
  names: Set<string>,
  count: number
): Promise<number> {
  let remaining = Math.max(0, count);
  let taken = 0;
  for (const item of containerItems(container)) {
    if (remaining <= 0) break;
    if (!names.has(item.name)) continue;
    const amount = Math.min(remaining, item.count);
    if (amount <= 0) continue;
    await container.withdraw(item.type, item.metadata ?? null, amount);
    remaining -= amount;
    taken += amount;
    await sleep(50);
  }
  return taken;
}

async function withPortableShulker(
  instance: BotInstance,
  shulkerName: string,
  token: TaskToken,
  action: (container: OpenContainer) => Promise<void>
): Promise<void> {
  const bot = requireBot(instance);
  const beforeShulkers = bot.inventory
    .items()
    .reduce((sum, item) => sum + (item.name === shulkerName ? item.count : 0), 0);
  const location = findSafePortablePosition(bot);
  if (!location) throw new Error("No safe temporary spot for shulker");

  const item = bot.inventory.items().find((entry) => entry.name === shulkerName);
  if (!item) throw new Error(`${shulkerName} not in inventory`);

  bot.pathfinder?.setGoal(null);
  bot.clearControlStates();
  await sleep(100);
  await bot.equip(item, "hand");
  await bot.lookAt(location.support.position.offset(0.5, 0.8, 0.5), false);
  await bot.placeBlock(location.support, location.face);
  await sleep(160);

  const placed = bot.blockAt(location.target);
  if (!placed || placed.name !== shulkerName) {
    throw new Error("Could not place shulker");
  }

  let container: OpenContainer | null = null;
  try {
    container = await openContainer(bot, placed);
    await action(container);
  } finally {
    try {
      container?.close();
    } catch {
      /* no-op */
    }

    // only the shulker at the exact coordinate this function placed is reclaimed
    const live = bot.blockAt(location.target);
    if (live?.name === shulkerName && bot.canDigBlock(live)) {
      try {
        const toolBot = bot as unknown as { tool?: { equipForBlock(block: unknown): Promise<void> } };
        await toolBot.tool?.equipForBlock(live);
      } catch {
        /* hand dig fallback */
      }
      bot.pathfinder?.setGoal(null);
      bot.clearControlStates();
      await sleep(80);
      await bot.dig(live);
      await sleep(140);
      await instance.gather.runCollectDrops("shulker_box", 8, { cancelled: false }, () => {});
    }
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const now = bot.inventory
      .items()
      .reduce((sum, entry) => sum + (entry.name === shulkerName ? entry.count : 0), 0);
    if (now >= beforeShulkers) return;
    await sleep(100);
  }
  throw new Error("Temporary shulker could not be reclaimed; check logs for position");
}

function findSafePortablePosition(bot: Bot): {
  target: import("vec3").Vec3;
  support: NonNullable<ReturnType<Bot["blockAt"]>>;
  face: import("vec3").Vec3;
} | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vec3Module = require("vec3");
  const Vec3 = (vec3Module.Vec3 ?? vec3Module) as typeof import("vec3").Vec3;
  const bx = Math.floor(bot.entity.position.x);
  const by = Math.floor(bot.entity.position.y);
  const bz = Math.floor(bot.entity.position.z);
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1]
  ]) {
    const target = new Vec3(bx + dx!, by, bz + dz!);
    const current = bot.blockAt(target);
    const support = bot.blockAt(target.offset(0, -1, 0));
    if (!support || support.name.includes("air") || support.name === "water" || support.name === "lava") continue;
    if (current && !current.name.includes("air")) continue;
    return { target, support, face: new Vec3(0, 1, 0) };
  }
  return null;
}

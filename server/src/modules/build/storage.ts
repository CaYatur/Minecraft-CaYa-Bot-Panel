import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import { pathNear } from "./place";

const STORAGE_DISTANCE = 24;
const STORAGE_BLOCKS = new Set(["chest", "trapped_chest", "barrel"]);

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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline");
  return bot;
}

function isStorageBlock(name: string): boolean {
  return STORAGE_BLOCKS.has(name) || name.endsWith("_shulker_box") || name === "shulker_box";
}

function inventoryCount(bot: Bot, names: Set<string>): number {
  return bot.inventory.items().reduce((sum, item) => sum + (names.has(item.name) ? item.count : 0), 0);
}

function containerItems(container: OpenContainer): ContainerItem[] {
  try {
    if (typeof container.containerItems === "function") return container.containerItems();
    if (typeof container.items === "function") return container.items();
  } catch {
    // window kapandı / sunucu reddetti
  }
  return [];
}

async function openContainer(bot: Bot, block: unknown): Promise<OpenContainer> {
  const api = bot as unknown as { openContainer(block: unknown): Promise<OpenContainer> };
  if (typeof api.openContainer !== "function") throw new Error("openContainer not supported");
  return api.openContainer(block);
}

/**
 * Yakındaki oyuncu depolarından malzeme alır.
 * Sandık/barrel ve worldya placeilmiş shulker kutuları yalnızca açılır; kırılmaz.
 * Inventory has insufficient taşınan shulker ise safe noktaya geçici konur ve işlem sonunda geri alınır.
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
  const positions = bot.findBlocks({
    matching: (block) => isStorageBlock(block.name),
    maxDistance: STORAGE_DISTANCE,
    count: 96
  });
  positions.sort(
    (a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b)
  );

  const visited = new Set<string>();
  for (const position of positions) {
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    if (inventoryCount(bot, names) - before >= wanted) break;
    const key = `${position.x},${position.y},${position.z}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const block = bot.blockAt(position);
    if (!block || !isStorageBlock(block.name)) continue;
    onActivity(`Depo kontrol ediliyor: ${block.name} @${position.x},${position.y},${position.z}`);
    try {
      await pathNear(instance, position.x + 0.5, position.y, position.z + 0.5, 3.2, token, {
        clearGoal: true,
        timeoutMs: 7_000
      });
      bot.pathfinder?.setGoal(null);
      bot.clearControlStates();
      await sleep(90);
      await withdrawFromContainer(bot, block, names, wanted - (inventoryCount(bot, names) - before));
    } catch (error) {
      instance
        .getLogger()
        .warn("Storage read failed", `${block.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Dünyadaki depolar yetmediyse, botun taşıdığı shulker kutularına bak.
  if (inventoryCount(bot, names) - before < wanted) {
    const shulkers = bot.inventory.items().filter(
      (item) => item.name === "shulker_box" || item.name.endsWith("_shulker_box")
    );
    for (const shulker of shulkers) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      if (inventoryCount(bot, names) - before >= wanted) break;
      try {
        onActivity(`Opening carried shulker: ${shulker.name}`);
        await withPortableShulker(instance, shulker.name, token, async (container) => {
          await withdrawMatching(
            container,
            names,
            wanted - (inventoryCount(bot, names) - before)
          );
        });
      } catch (error) {
        instance
          .getLogger()
          .warn("Could not use shulker", error instanceof Error ? error.message : String(error));
      }
    }
  }

  const taken = Math.max(0, inventoryCount(bot, names) - before);
  if (taken > 0) onActivity(`Depodan withdrawn: ${[...names].join("/")} ×${taken}`);
  return taken;
}

async function withdrawFromContainer(
  bot: Bot,
  block: unknown,
  names: Set<string>,
  count: number
): Promise<number> {
  const container = await openContainer(bot, block);
  try {
    return await withdrawMatching(container, names, count);
  } finally {
    try {
      container.close();
    } catch {
      // no-op
    }
  }
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
  const beforeShulkers = bot.inventory.items().reduce(
    (sum, item) => sum + (item.name === shulkerName ? item.count : 0),
    0
  );
  const location = findSafePortablePosition(bot);
  if (!location) throw new Error("No safe temporary spot for shulker");

  const item = bot.inventory.items().find((entry) => entry.name === shulkerName);
  if (!item) throw new Error(`${shulkerName} inventoryde yok`);

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
      // no-op
    }

    // Yalnızca bu fonksiyonun placediği kesin koordinattaki shulker geri alınır.
    const live = bot.blockAt(location.target);
    if (live?.name === shulkerName && bot.canDigBlock(live)) {
      try {
        const toolBot = bot as unknown as { tool?: { equipForBlock(block: unknown): Promise<void> } };
        await toolBot.tool?.equipForBlock(live);
      } catch {
        // elle kırma denenir
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
    const now = bot.inventory.items().reduce(
      (sum, entry) => sum + (entry.name === shulkerName ? entry.count : 0),
      0
    );
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

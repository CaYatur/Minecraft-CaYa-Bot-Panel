import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import { sleep } from "./maneuver";
import { boundedOp, pathNear } from "./place";
import type { BuildStorageInfo } from "./types";
import { v3 } from "./vec3util";

/**
 * Chest/shulker stock ledger (issue #3): the bot MARKS nearby containers and
 * tracks their contents live instead of hauling everything into its inventory.
 * Materials in indexed storage count as available; the bot goes and withdraws
 * only what it needs, when it needs it, and the ledger updates instantly.
 * Snapshots are also forwarded to the persistent world memory (chestOpened).
 */

const STORAGE_BLOCKS = new Set(["chest", "trapped_chest", "barrel"]);

export function isStorageBlockName(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return STORAGE_BLOCKS.has(n) || n.endsWith("_shulker_box") || n === "shulker_box";
}

export interface StockContainer {
  x: number;
  y: number;
  z: number;
  dimension: string;
  blockName: string;
  /** item name → count */
  items: Map<string, number>;
  updatedAt: number;
  /** loaded from persistent world memory; not yet verified this session */
  seeded: boolean;
  /** consecutive open failures — skipped after 2 */
  failures: number;
}

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
  deposit?(type: number, metadata: number | null, count: number): Promise<void>;
  close(): void;
}

function keyOf(x: number, y: number, z: number, dimension: string): string {
  return `${dimension}:${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

export class ChestStockIndex {
  private containers = new Map<string, StockContainer>();

  clear() {
    this.containers.clear();
  }

  get size(): number {
    return this.containers.size;
  }

  list(): StockContainer[] {
    return [...this.containers.values()];
  }

  toInfo(lastScanAt: number | null): BuildStorageInfo {
    return { containers: this.containers.size, lastScanAt };
  }

  /** Seed known container positions/contents from persistent world memory. */
  seed(rows: Array<{ x: number; y: number; z: number; dimension: string; items: { name: string; count: number }[] }>, dimension: string) {
    for (const row of rows) {
      if (row.dimension && row.dimension !== dimension) continue;
      const k = keyOf(row.x, row.y, row.z, dimension);
      if (this.containers.has(k)) continue;
      this.containers.set(k, {
        x: Math.floor(row.x),
        y: Math.floor(row.y),
        z: Math.floor(row.z),
        dimension,
        blockName: "chest",
        items: new Map(row.items.map((i) => [i.name.replace(/^minecraft:/, ""), i.count])),
        updatedAt: 0,
        seeded: true,
        failures: 0
      });
    }
  }

  record(x: number, y: number, z: number, dimension: string, blockName: string, items: ContainerItem[]) {
    const k = keyOf(x, y, z, dimension);
    const merged = new Map<string, number>();
    for (const it of items) {
      const n = it.name.replace(/^minecraft:/, "");
      merged.set(n, (merged.get(n) ?? 0) + it.count);
    }
    this.containers.set(k, {
      x: Math.floor(x),
      y: Math.floor(y),
      z: Math.floor(z),
      dimension,
      blockName: blockName.replace(/^minecraft:/, ""),
      items: merged,
      updatedAt: Date.now(),
      seeded: false,
      failures: 0
    });
  }

  remove(x: number, y: number, z: number, dimension: string) {
    this.containers.delete(keyOf(x, y, z, dimension));
  }

  noteFailure(x: number, y: number, z: number, dimension: string) {
    const c = this.containers.get(keyOf(x, y, z, dimension));
    if (c) c.failures += 1;
  }

  applyWithdraw(x: number, y: number, z: number, dimension: string, itemName: string, count: number) {
    const c = this.containers.get(keyOf(x, y, z, dimension));
    if (!c) return;
    const n = itemName.replace(/^minecraft:/, "");
    const left = (c.items.get(n) ?? 0) - count;
    if (left > 0) c.items.set(n, left);
    else c.items.delete(n);
    c.updatedAt = Date.now();
  }

  applyDeposit(x: number, y: number, z: number, dimension: string, itemName: string, count: number) {
    const c = this.containers.get(keyOf(x, y, z, dimension));
    if (!c) return;
    const n = itemName.replace(/^minecraft:/, "");
    c.items.set(n, (c.items.get(n) ?? 0) + count);
    c.updatedAt = Date.now();
  }

  /** Total stock of any of the names across indexed containers. */
  stockOf(names: Iterable<string>): number {
    const set = new Set([...names].map((n) => n.replace(/^minecraft:/, "")));
    let total = 0;
    for (const c of this.containers.values()) {
      if (c.failures >= 2) continue;
      for (const n of set) total += c.items.get(n) ?? 0;
    }
    return total;
  }

  /** Containers holding any of the names, nearest first. */
  containersWith(names: Iterable<string>, from: { x: number; y: number; z: number }): StockContainer[] {
    const set = new Set([...names].map((n) => n.replace(/^minecraft:/, "")));
    const out: StockContainer[] = [];
    for (const c of this.containers.values()) {
      if (c.failures >= 2) continue;
      let has = false;
      for (const n of set) {
        if ((c.items.get(n) ?? 0) > 0) {
          has = true;
          break;
        }
      }
      if (has) out.push(c);
    }
    out.sort(
      (a, b) =>
        Math.hypot(a.x - from.x, a.y - from.y, a.z - from.z) - Math.hypot(b.x - from.x, b.y - from.y, b.z - from.z)
    );
    return out;
  }
}

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline");
  return bot;
}

function invCount(bot: Bot, names: Set<string>): number {
  return bot.inventory.items().reduce((s, i) => s + (names.has(i.name) ? i.count : 0), 0);
}

async function openContainerAt(bot: Bot, block: unknown): Promise<OpenContainer> {
  const api = bot as unknown as { openContainer(block: unknown): Promise<OpenContainer> };
  if (typeof api.openContainer !== "function") throw new Error("openContainer not supported");
  // yanıtsız pencere isteği runner'ı asmasın (issue #4)
  return boundedOp(api.openContainer(block), null, 8_000, "openContainer");
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

/** Snapshot one container into the index + persistent world memory. */
function recordSnapshot(
  instance: BotInstance,
  index: ChestStockIndex,
  pos: { x: number; y: number; z: number },
  blockName: string,
  items: ContainerItem[]
) {
  const dimension = instance.runtime.dimension;
  index.record(pos.x, pos.y, pos.z, dimension, blockName, items);
  instance.emit("chestOpened", {
    serverId: instance.config.serverId,
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
    dimension,
    items: items.map((i) => ({ name: i.name, count: i.count }))
  });
}

/**
 * Scan nearby containers: walk to each, open, snapshot, close.
 * Marks stock WITHOUT withdrawing anything.
 */
export async function scanNearbyStorage(
  instance: BotInstance,
  index: ChestStockIndex,
  opts: { radius?: number; maxContainers?: number; budgetMs?: number },
  token: TaskToken,
  onActivity: (label: string) => void = () => {}
): Promise<{ scanned: number; found: number }> {
  const bot = requireBot(instance);
  const radius = Math.max(4, Math.min(64, opts.radius ?? 32));
  const maxContainers = Math.max(1, Math.min(64, opts.maxContainers ?? 24));
  const deadline = Date.now() + (opts.budgetMs ?? 90_000);
  const dimension = instance.runtime.dimension;

  const positions = bot.findBlocks({
    matching: (b) => isStorageBlockName(b.name),
    maxDistance: radius,
    count: 128
  });
  // include seeded (world-memory) containers within radius that findBlocks missed (unloaded)
  const known = index
    .list()
    .filter((c) => c.seeded && c.dimension === dimension)
    .map((c) => v3(c.x, c.y, c.z))
    .filter((p) => bot.entity.position.distanceTo(p) <= radius);
  for (const p of known) {
    if (!positions.some((q) => q.equals(p))) positions.push(p);
  }
  positions.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));

  let scanned = 0;
  const visited = new Set<string>();
  for (const pos of positions) {
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    if (scanned >= maxContainers || Date.now() > deadline) break;
    const vkey = `${pos.x},${pos.y},${pos.z}`;
    if (visited.has(vkey)) continue;
    visited.add(vkey);

    onActivity(`Marking storage: @${pos.x},${pos.y},${pos.z}`);
    try {
      await pathNear(instance, pos.x + 0.5, pos.y, pos.z + 0.5, 3.0, token, { clearGoal: true, timeoutMs: 9_000 });
      const block = bot.blockAt(pos);
      if (!block || !isStorageBlockName(block.name)) {
        index.remove(pos.x, pos.y, pos.z, dimension);
        continue;
      }
      bot.pathfinder?.setGoal(null);
      bot.clearControlStates();
      await sleep(80);
      const container = await openContainerAt(bot, block);
      try {
        recordSnapshot(instance, index, pos, block.name, containerItems(container));
        scanned++;
      } finally {
        try {
          container.close();
        } catch {
          /* no-op */
        }
      }
      await sleep(60);
    } catch (e) {
      index.noteFailure(pos.x, pos.y, pos.z, dimension);
      instance
        .getLogger()
        .debug?.(`Storage scan skip @${pos.x},${pos.y},${pos.z}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { scanned, found: positions.length };
}

/** Rough free capacity for an item in the bot inventory (empty slots × stack + partial stacks). */
export function inventorySpaceFor(bot: Bot, itemName: string): number {
  const n = itemName.replace(/^minecraft:/, "");
  const def = bot.registry.itemsByName[n];
  const stackSize = def?.stackSize ?? 64;
  const empty = bot.inventory.emptySlotCount();
  let partial = 0;
  for (const it of bot.inventory.items()) {
    if (it.name === n && it.count < stackSize) partial += stackSize - it.count;
  }
  return empty * stackSize + partial;
}

/**
 * Withdraw up to `count` of any of `itemNames` from indexed containers,
 * walking to each and updating the ledger live.
 */
export async function fetchFromStorage(
  instance: BotInstance,
  index: ChestStockIndex,
  itemNames: string[],
  count: number,
  token: TaskToken,
  onActivity: (label: string) => void = () => {}
): Promise<number> {
  const bot = requireBot(instance);
  const names = new Set(itemNames.map((n) => n.replace(/^minecraft:/, "")));
  const wanted = Math.max(0, Math.floor(count));
  if (!wanted || !names.size) return 0;
  const dimension = instance.runtime.dimension;
  const before = invCount(bot, names);

  let guard = 0;
  while (invCount(bot, names) - before < wanted && guard++ < 12) {
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    const targets = index.containersWith(names, bot.entity.position);
    const target = targets[0];
    if (!target) break;

    const space = Math.max(...[...names].map((n) => inventorySpaceFor(bot, n)));
    if (space <= 0) {
      onActivity("Inventory full — cannot withdraw from storage");
      break;
    }

    onActivity(`Fetching from storage: @${target.x},${target.y},${target.z}`);
    try {
      await pathNear(instance, target.x + 0.5, target.y, target.z + 0.5, 3.0, token, {
        clearGoal: true,
        timeoutMs: 12_000
      });
      const block = bot.blockAt(v3(target.x, target.y, target.z));
      if (!block || !isStorageBlockName(block.name)) {
        index.remove(target.x, target.y, target.z, dimension);
        continue;
      }
      bot.pathfinder?.setGoal(null);
      bot.clearControlStates();
      await sleep(80);
      const container = await openContainerAt(bot, block);
      try {
        // fresh snapshot first — ledger may be stale
        const live = containerItems(container);
        recordSnapshot(instance, index, target, block.name, live);
        let need = wanted - (invCount(bot, names) - before);
        for (const it of live) {
          if (need <= 0) break;
          const n = it.name.replace(/^minecraft:/, "");
          if (!names.has(n)) continue;
          const amount = Math.min(need, it.count, inventorySpaceFor(bot, n));
          if (amount <= 0) continue;
          await boundedOp(container.withdraw(it.type, it.metadata ?? null, amount), token, 8_000, "withdraw");
          index.applyWithdraw(target.x, target.y, target.z, dimension, n, amount);
          need -= amount;
          onActivity(`Withdrawn: ${n} ×${amount}`);
          await sleep(60);
        }
      } finally {
        try {
          container.close();
        } catch {
          /* no-op */
        }
      }
    } catch (e) {
      index.noteFailure(target.x, target.y, target.z, dimension);
      instance
        .getLogger()
        .warn("Storage fetch failed", `${target.x},${target.y},${target.z}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return Math.max(0, invCount(bot, names) - before);
}

/**
 * Free inventory slots by depositing non-essential items into the nearest
 * indexed container. Protects tools, food, scaffold blocks and `protect` names.
 */
export async function makeInventoryRoom(
  instance: BotInstance,
  index: ChestStockIndex,
  protect: Set<string>,
  slotsWanted: number,
  token: TaskToken,
  onActivity: (label: string) => void = () => {}
): Promise<boolean> {
  const bot = requireBot(instance);
  if (bot.inventory.emptySlotCount() >= slotsWanted) return true;
  const dimension = instance.runtime.dimension;

  const isProtected = (name: string): boolean => {
    if (protect.has(name)) return true;
    if (instance.config.inventory.keepItems.includes(name)) return true;
    if (instance.config.movement.scaffoldBlocks.includes(name)) return true;
    if (/_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|shears$|bucket$/.test(name)) return true;
    if (/_helmet$|_chestplate$|_leggings$|_boots$|shield$/.test(name)) return true;
    if (name.endsWith("_shulker_box") || name === "shulker_box") return true;
    const def = bot.registry.foodsByName?.[name];
    if (def) return true;
    return false;
  };

  const candidates = index
    .list()
    .filter((c) => c.dimension === dimension && c.failures < 2)
    .sort(
      (a, b) =>
        bot.entity.position.distanceTo(v3(a.x, a.y, a.z)) - bot.entity.position.distanceTo(v3(b.x, b.y, b.z))
    );

  for (const target of candidates) {
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    if (bot.inventory.emptySlotCount() >= slotsWanted) return true;
    onActivity(`Depositing extras: @${target.x},${target.y},${target.z}`);
    try {
      await pathNear(instance, target.x + 0.5, target.y, target.z + 0.5, 3.0, token, {
        clearGoal: true,
        timeoutMs: 10_000
      });
      const block = bot.blockAt(v3(target.x, target.y, target.z));
      if (!block || !isStorageBlockName(block.name)) {
        index.remove(target.x, target.y, target.z, dimension);
        continue;
      }
      const container = await openContainerAt(bot, block);
      try {
        recordSnapshot(instance, index, target, block.name, containerItems(container));
        for (const it of bot.inventory.items()) {
          if (bot.inventory.emptySlotCount() >= slotsWanted) break;
          if (isProtected(it.name)) continue;
          if (!container.deposit) break;
          try {
            await boundedOp(container.deposit(it.type, null, it.count), null, 8_000, "deposit");
            index.applyDeposit(target.x, target.y, target.z, dimension, it.name, it.count);
            onActivity(`Deposited: ${it.name} ×${it.count}`);
            await sleep(60);
          } catch {
            break; // container full
          }
        }
      } finally {
        try {
          container.close();
        } catch {
          /* no-op */
        }
      }
    } catch {
      index.noteFailure(target.x, target.y, target.z, dimension);
    }
  }
  return bot.inventory.emptySlotCount() >= slotsWanted;
}

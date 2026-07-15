import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { ensureMovement, runGoto } from "../movement";
import { ringSearch } from "./ringSearch";
// caya-build-resource-storage-v1: gather
import { collectDropsAfterDig, runSmartCollectBlock, runSmartCollectDrops } from "./smartGather";

const LOG_BLOCKS = new Set([
  "oak_log",
  "birch_log",
  "spruce_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "crimson_stem",
  "warped_stem"
]);

export type CountMode = "add" | "target";

interface DigOptions {
  pickup?: boolean;
  canDigRoute?: boolean;
  allowPlaceRoute?: boolean;
}

/**
 * Kaynak toplama (Faz 8): yüzey-ağaç planlayıcısı, ground items ve madencilik.
 *
 * Miktar semantiği:
 * - add: mevcut inventorye belirtilen miktarı EKLER.
 * - target: inventory toplamını belirtilen miktara ulaştırır.
 */
export class GatherService {
  constructor(private readonly instance: BotInstance) {}

  private log() {
    return this.instance.getLogger();
  }

  enqueueCollectWood(
    count = 16,
    logType?: string,
    priority: number = PRIORITY.AUTO,
    countMode: CountMode = "target"
  ) {
    const n = Math.max(1, Math.min(256, Math.floor(count)));
    const modeText = countMode === "add" ? `+${n}` : `target ${n}`;
    return this.instance.tasks.enqueue(
      {
        type: "collect-wood",
        label: `odun topla ${modeText}${logType ? ` (${logType})` : ""}`,
        priority,
        params: { count: n, logType: logType ?? null, countMode },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectWood(n, logType, token, report, countMode)
    );
  }

  enqueueCollectDrops(filter?: string, radius = 16, priority: number = PRIORITY.USER) {
    return this.instance.tasks.enqueue(
      {
        type: "collect-drops",
        label: `ground items${filter ? `: ${filter}` : ""}`,
        priority,
        params: { filter: filter ?? null, radius },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectDrops(filter, radius, token, report)
    );
  }

  enqueueMine(
    ore: string,
    count = 8,
    mode: "legit" | "utility" = "legit",
    priority: number = PRIORITY.AUTO,
    countMode: CountMode = "target"
  ) {
    const n = Math.max(1, Math.min(128, Math.floor(count)));
    const modeText = countMode === "add" ? `+${n}` : `target ${n}`;
    return this.instance.tasks.enqueue(
      {
        type: "mine",
        label: `maden: ${ore} ${modeText} (${mode})`,
        priority,
        params: { ore, count: n, mode, countMode },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runMine(ore, n, mode, token, report, countMode)
    );
  }

  /** Akıllı kaynak planlayıcısı: odun/maden/craft/doğrudan blok stratejisini seçer. */
  enqueueCollectBlock(
    blockOrItem: string,
    count = 8,
    priority: number = PRIORITY.USER,
    countMode: CountMode = "target"
  ) {
    const n = Math.max(1, Math.min(256, Math.floor(count)));
    const name = blockOrItem.replace(/^minecraft:/, "");
    const modeText = countMode === "add" ? `+${n}` : `target ${n}`;
    return this.instance.tasks.enqueue(
      {
        type: "collect-block",
        label: `smart resource: ${name} ${modeText}`,
        priority,
        params: { name, count: n, countMode },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectBlock(name, n, token, report, countMode)
    );
  }

  async runCollectWood(
    amount: number,
    logType: string | undefined,
    token: TaskToken,
    report: ProgressFn,
    countMode: CountMode = "target"
  ) {
    const bot = this.requireBot();
    const match = (name: string) =>
      logType ? name === logType : LOG_BLOCKS.has(name) || name.endsWith("_log") || name.endsWith("_stem");
    const countNow = () => this.countItems(bot, match);
    const start = countNow();
    const target = countMode === "add" ? start + Math.max(1, amount) : Math.max(1, amount);
    const requestedDelta = Math.max(0, target - start);
    const blockedTrees = new Map<string, number>();
    let noProgressTrees = 0;

    const reportProgress = (label?: string) => {
      const current = countNow();
      const gained = Math.max(0, current - start);
      report({
        done: Math.min(gained, requestedDelta),
        total: requestedDelta,
        label: label ?? `odun +${gained}/${requestedDelta} · inventory ${current}/${target}`
      });
    };

    reportProgress(`searching surface trees · inventory ${start}, target ${target}`);
    if (start >= target) {
      this.log().success(`Wood target already met (${start}/${target})`);
      return;
    }

    while (countNow() < target && !token.cancelled) {
      let base = this.findTreeBase(bot, match, 40, blockedTrees);
      if (!base) {
        const found = await ringSearch(this.instance, token, report, {
          step: 24,
          maxRadius: 144,
          surfaceTravel: true,
          movement: { canDig: false, allowPlace: false, parkour: true, timeoutMs: 45_000 },
          probe: (probeBot) => Boolean(this.findTreeBase(probeBot, match, 28, blockedTrees))
        });
        if (!found) throw new Error("No reachable surface tree found (no terrain dig)");
        base = this.findTreeBase(bot, match, 40, blockedTrees);
      }
      if (!base) continue;

      const baseKey = posKey(base.position);
      const before = countNow();
      reportProgress(`cutting tree: ${base.name} @ ${base.position.x},${base.position.y},${base.position.z}`);

      try {
        const remaining = Math.max(1, target - before);
        const dug = await this.harvestReachableTree(bot, base, match, remaining, token, reportProgress);
        if (dug <= 0) throw new Error("could not dig accessible tree trunk");
        await collectDropsAfterDig(this.instance, logType, token);
        await this.tryReplant(bot, base.position);
      } catch (error) {
        const failures = (blockedTrees.get(baseKey) ?? 0) + 1;
        blockedTrees.set(baseKey, failures);
        this.log().warn(
          `Tree candidate skipped (${failures}/2)`,
          error instanceof Error ? error.message : String(error)
        );
      }

      const after = countNow();
      if (after <= before) {
        noProgressTrees += 1;
        blockedTrees.set(baseKey, Math.max(2, blockedTrees.get(baseKey) ?? 0));
        if (noProgressTrees >= 6) {
          throw new Error("Tree cut but wood not in inventory; unreachable candidates exhausted");
        }
      } else {
        noProgressTrees = 0;
      }
      reportProgress();
    }

    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    this.log().success(`Odun toplama bitti (+${countNow() - start}, inventory ${countNow()})`);
  }

  async runCollectDrops(filter: string | undefined, radius: number, token: TaskToken, report: ProgressFn) {
    const picked = await runSmartCollectDrops(this.instance, filter, radius, token, report);
    this.log().success(`Ground item pickup (verified: ${picked})`);
  }

  async runCollectBlock(
    name: string,
    amount: number,
    token: TaskToken,
    report: ProgressFn,
    countMode: CountMode = "target"
  ) {
    await runSmartCollectBlock(this.instance, name, amount, token, report, countMode);
    this.log().success(`Smart gather finished: ${name} · ${countMode === "add" ? "+" : "target "}${amount}`);
  }

  async runMine(
    ore: string,
    amount: number,
    mode: "legit" | "utility",
    token: TaskToken,
    report: ProgressFn,
    countMode: CountMode = "target"
  ) {
    const bot = this.requireBot();
    const oreName = normalizeOreName(ore);
    const blockNames = oreVariants(oreName);
    const inventoryNames = oreInventoryNames(oreName);
    const countNow = () => this.countItems(bot, (name) => inventoryNames.has(name));
    const start = countNow();
    const target = countMode === "add" ? start + Math.max(1, amount) : Math.max(1, amount);
    const requestedDelta = Math.max(0, target - start);
    let got = start;
    report({ done: 0, total: requestedDelta, label: `${oreName}: inventory ${start}, target ${target}` });

    if (got >= target) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const toolPlugin = require("mineflayer-tool").plugin;
      if (!(bot as unknown as { tool?: unknown }).tool) bot.loadPlugin(toolPlugin);
    } catch {
      /* optional */
    }

    let skippedLava = 0;
    while (got < target && !token.cancelled) {
      let block = bot.findBlock({
        matching: (candidate) => blockNames.includes(candidate.name),
        maxDistance: mode === "utility" ? 64 : 32
      });

      if (!block && mode === "legit") {
        const found = await ringSearch(this.instance, token, report, {
          step: 20,
          maxRadius: 96,
          movement: { canDig: true, allowPlace: true, parkour: true, timeoutMs: 60_000 },
          probe: (probeBot) =>
            Boolean(
              probeBot.findBlock({
                matching: (candidate) => blockNames.includes(candidate.name),
                maxDistance: 18
              })
            )
        });
        if (!found) throw new Error(`${oreName} ore not found`);
        block = bot.findBlock({
          matching: (candidate) => blockNames.includes(candidate.name),
          maxDistance: 36
        });
      }

      if (!block) throw new Error(`${oreName} ore block missing`);

      if (this.hasLavaNear(bot, block.position)) {
        skippedLava += 1;
        if (skippedLava >= 8) throw new Error(`${oreName}: unsafe lava-adjacent candidates exhausted`);
        this.log().warn("Near lava — ore skipped");
        await sleep(180);
        continue;
      }
      skippedLava = 0;

      await this.digBlock(bot, block, token, { canDigRoute: true, allowPlaceRoute: true });
      got = countNow();
      report({
        done: Math.min(Math.max(0, got - start), requestedDelta),
        total: requestedDelta,
        label: `${oreName} +${Math.max(0, got - start)}/${requestedDelta} · inventory ${got}/${target}`
      });
    }
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    this.log().success(`Madencilik done: ${oreName} +${got - start} (inventory ${got})`);
  }

  private findTreeBase(
    bot: Bot,
    match: (name: string) => boolean,
    maxDistance: number,
    blocked: Map<string, number>
  ): Block | null {
    const positions = bot.findBlocks({
      matching: (block) => match(block.name),
      maxDistance,
      count: 256
    });
    const unique = new Map<string, Block>();

    for (const position of positions) {
      let current = bot.blockAt(position);
      if (!current || !match(current.name)) continue;
      // Aynı gövde kolonunun en alt log'una in; üstteki yaprak içi loglara kilitlenme.
      for (let i = 0; i < 20; i += 1) {
        const below = bot.blockAt(current.position.offset(0, -1, 0));
        if (!below || !match(below.name)) break;
        current = below;
      }
      const key = posKey(current.position);
      if ((blocked.get(key) ?? 0) >= 2) continue;
      unique.set(key, current);
    }

    const here = bot.entity.position;
    const candidates = [...unique.values()].filter((block) => {
      const below = bot.blockAt(block.position.offset(0, -1, 0));
      if (!below || below.boundingBox === "empty") return false; // floating/player decoration
      const exposed = HORIZONTAL.some(([x, z]) => {
        const side = bot.blockAt(block.position.offset(x, 0, z));
        return !side || side.boundingBox === "empty" || side.name.includes("leaves") || side.name === "vine";
      });
      return exposed;
    });

    candidates.sort((a, b) => treeScore(here, a) - treeScore(here, b));
    return candidates[0] ?? null;
  }

  private async harvestReachableTree(
    bot: Bot,
    base: Block,
    match: (name: string) => boolean,
    remaining: number,
    token: TaskToken,
    report: (label?: string) => void
  ): Promise<number> {
    // Ağaç yolunda arazi kazma ve rastgele scaffold kesinlikle kapalıdır.
    await runGoto(
      this.instance,
      base.position.x,
      base.position.y,
      base.position.z,
      3,
      token,
      () => {},
      { canDig: false, allowPlace: false, parkour: true, timeoutMs: 45_000 }
    );

    const positions = bot.findBlocks({
      matching: (block) => match(block.name),
      point: base.position,
      maxDistance: 8,
      count: 96
    });
    const connected = connectedTreePositions(bot, base.position, positions, match)
      .sort((a, b) => a.y - b.y || bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
      .slice(0, Math.min(32, remaining + 4));

    let dug = 0;
    let misses = 0;
    for (const position of connected) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      const live = bot.blockAt(position);
      if (!live || !match(live.name)) continue;
      try {
        report(`cutting trunk ${dug + 1}/${Math.min(connected.length, remaining)}`);
        await this.digBlock(bot, live, token, {
          pickup: false,
          canDigRoute: false,
          allowPlaceRoute: false
        });
        dug += 1;
        misses = 0;
        if (dug >= remaining) break;
      } catch {
        misses += 1;
        // Üst dallar erişilemiyorsa ağacı drop; başka yüzey ağacına geçmek daha mantıklıdır.
        if (misses >= 3) break;
      }
    }
    return dug;
  }

  private async tryReplant(bot: Bot, base: Vec3) {
    try {
      const sap = bot.inventory.items().find((item) => item.name.endsWith("_sapling") || item.name === "mangrove_propagule");
      if (!sap) return;
      const dirt = bot.blockAt(base.offset(0, -1, 0));
      const air = bot.blockAt(base);
      if (!dirt || !air || air.boundingBox !== "empty") return;
      if (!(dirt.name.includes("dirt") || dirt.name.includes("grass") || dirt.name === "mud")) return;
      await bot.equip(sap, "hand");
      await bot.placeBlock(dirt, new Vec3(0, 1, 0));
    } catch {
      /* replant best-effort */
    }
  }

  private async digBlock(bot: Bot, block: Block | { position: { x: number; y: number; z: number }; name: string }, token: TaskToken, options: DigOptions = {}) {
    const pos = new Vec3(Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z));
    const beforeMove = bot.blockAt(pos);
    const alreadyReachable = Boolean(
      beforeMove &&
      bot.entity.position.distanceTo(beforeMove.position.offset(0.5, 0.5, 0.5)) <= 4.6 &&
      bot.canDigBlock(beforeMove)
    );

    // Aynı ağacın yan ymain gövdelerinde her blok for yeniden path hesaplamak çok
    // yavaştı. El menzilindeyse doğrudan kaz; yalnızca gerektiğinde yaklaş.
    if (!alreadyReachable) {
      await runGoto(
        this.instance,
        block.position.x,
        block.position.y,
        block.position.z,
        3,
        token,
        () => {},
        {
          canDig: options.canDigRoute ?? true,
          allowPlace: options.allowPlaceRoute ?? true,
          parkour: true,
          timeoutMs: options.canDigRoute === false ? 45_000 : 90_000
        }
      );
    }
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    ensureMovement(this.instance, {
      mode: "goto",
      canDig: options.canDigRoute ?? true,
      allowPlace: options.allowPlaceRoute ?? true
    });
    const live = bot.blockAt(pos);
    if (!live) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const toolPlugin = require("mineflayer-tool").plugin;
      if (!(bot as unknown as { tool?: unknown }).tool) bot.loadPlugin(toolPlugin);
      const toolBot = bot as unknown as { tool?: { equipForBlock(block: unknown): Promise<void> } };
      if (toolBot.tool) await toolBot.tool.equipForBlock(live);
    } catch {
      /* no tool plugin */
    }
    if (bot.heldItem && this.instance.config.inventory.bannedItems.includes(bot.heldItem.name)) {
      throw new Error(`Held tool is banned: ${bot.heldItem.name}`);
    }
    if (!bot.canDigBlock(live)) throw new Error(`${live.name} cannot dig from this position`);
    await bot.dig(live);
    if (options.pickup !== false) await collectDropsAfterDig(this.instance, live.name, token);
  }

  private hasLavaNear(bot: Bot, pos: { x: number; y: number; z: number }) {
    for (const [x, y, z] of NEIGHBORS) {
      const block = bot.blockAt(new Vec3(pos.x + x, pos.y + y, pos.z + z));
      if (block && (block.name === "lava" || block.name === "flowing_lava")) return true;
    }
    return false;
  }

  private countItems(bot: Bot, pred: (name: string) => boolean) {
    return bot.inventory.items().reduce((sum, item) => sum + (pred(item.name) ? item.count : 0), 0);
  }

  private requireBot(): Bot {
    const bot = this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot offline");
    return bot;
  }
}

const HORIZONTAL: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];
const NEIGHBORS: Array<[number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
];

function treeScore(origin: Vec3, block: Block): number {
  const horizontal = Math.hypot(origin.x - block.position.x, origin.z - block.position.z);
  const vertical = Math.abs(origin.y - block.position.y);
  // Yakın ama tepenin forde remaining log yerine doğal, benzer seviyedeki gövdeyi seç.
  return horizontal + vertical * 2.5 + (block.position.y > origin.y + 12 ? 24 : 0);
}

function connectedTreePositions(bot: Bot, base: Vec3, positions: Vec3[], match: (name: string) => boolean): Vec3[] {
  const available = new Map<string, Vec3>();
  for (const position of positions) {
    const live = bot.blockAt(position);
    if (live && match(live.name)) available.set(posKey(position), position.clone());
  }
  available.set(posKey(base), base.clone());

  const result: Vec3[] = [];
  const queue: Vec3[] = [base.clone()];
  const seen = new Set<string>();
  while (queue.length > 0 && result.length < 64) {
    const current = queue.shift()!;
    const key = posKey(current);
    if (seen.has(key) || !available.has(key)) continue;
    seen.add(key);
    result.push(current);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const next = current.offset(dx, dy, dz);
          const nextKey = posKey(next);
          if (!seen.has(nextKey) && available.has(nextKey)) queue.push(next);
        }
      }
    }
  }
  return result;
}

function normalizeOreName(ore: string): string {
  return ore
    .replace(/^minecraft:/, "")
    .replace(/^deepslate_/, "")
    .replace(/_ore$/, "")
    .replace(/^raw_/, "")
    .replace(/_ingot$/, "");
}

function oreVariants(ore: string): string[] {
  const o = normalizeOreName(ore);
  if (o === "nether_gold") return ["nether_gold_ore"];
  if (o === "quartz") return ["nether_quartz_ore"];
  if (o === "ancient_debris") return ["ancient_debris"];
  return [`${o}_ore`, `deepslate_${o}_ore`];
}

function oreInventoryNames(ore: string): Set<string> {
  const o = normalizeOreName(ore);
  if (o === "ancient_debris") return new Set(["ancient_debris", "netherite_scrap", "netherite_ingot"]);
  if (o === "quartz") return new Set(["quartz", "nether_quartz_ore"]);
  if (o === "nether_gold") return new Set(["gold_nugget", "nether_gold_ore"]);
  if (["iron", "gold", "copper"].includes(o)) {
    return new Set([`raw_${o}`, `${o}_ingot`, `${o}_ore`, `deepslate_${o}_ore`, `raw_${o}_block`]);
  }
  if (["diamond", "emerald", "coal", "lapis", "redstone"].includes(o)) {
    return new Set([o, `${o}_ore`, `deepslate_${o}_ore`, `${o}_block`]);
  }
  return new Set([o, `${o}_ore`, `deepslate_${o}_ore`, `raw_${o}`, `${o}_ingot`]);
}

function posKey(pos: { x: number; y: number; z: number }) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { ringSearch } from "./ringSearch";

import type { Bot } from "mineflayer";
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

/**
 * Kaynak toplama (Faz 8): halka arama, ağaç, yerdeki eşya, basit madencilik.
 */
export class GatherService {
  constructor(private readonly instance: BotInstance) {}

  private log() {
    return this.instance.getLogger();
  }

  enqueueCollectWood(count = 16, logType?: string, priority = PRIORITY.AUTO) {
    const n = Math.max(1, Math.min(256, Math.floor(count)));
    return this.instance.tasks.enqueue(
      {
        type: "collect-wood",
        label: `odun topla ×${n}${logType ? ` (${logType})` : ""}`,
        priority,
        params: { count: n, logType: logType ?? null },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectWood(n, logType, token, report)
    );
  }

  enqueueCollectDrops(filter?: string, radius = 16, priority = PRIORITY.USER) {
    return this.instance.tasks.enqueue(
      {
        type: "collect-drops",
        label: `eşya topla${filter ? `: ${filter}` : ""}`,
        priority,
        params: { filter: filter ?? null, radius },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectDrops(filter, radius, token, report)
    );
  }

  enqueueMine(ore: string, count = 8, mode: "legit" | "utility" = "legit", priority = PRIORITY.AUTO) {
    const n = Math.max(1, Math.min(128, Math.floor(count)));
    return this.instance.tasks.enqueue(
      {
        type: "mine",
        label: `maden: ${ore} ×${n} (${mode})`,
        priority,
        params: { ore, count: n, mode },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runMine(ore, n, mode, token, report)
    );
  }

  /** Yapı malzemesi: blok/item adına göre yakında kaz + halka ara */
  enqueueCollectBlock(blockOrItem: string, count = 8, priority = PRIORITY.USER) {
    const n = Math.max(1, Math.min(256, Math.floor(count)));
    const name = blockOrItem.replace(/^minecraft:/, "");
    return this.instance.tasks.enqueue(
      {
        type: "collect-block",
        label: `kaynak: ${name} ×${n}`,
        priority,
        params: { name, count: n },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectBlock(name, n, token, report)
    );
  }

  async runCollectWood(need: number, logType: string | undefined, token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    let got = this.countItems(bot, (n) => (logType ? n === logType : LOG_BLOCKS.has(n) || n.endsWith("_log")));
    report({ done: got, total: need, label: `odun ${got}/${need}` });

    while (got < need && !token.cancelled) {
      const match = (name: string) => (logType ? name === logType : LOG_BLOCKS.has(name) || name.endsWith("_log"));
      let block = bot.findBlock({ matching: (b) => match(b.name), maxDistance: 32 });

      if (!block) {
        const found = await ringSearch(this.instance, token, report, {
          step: 32,
          maxRadius: 128,
          probe: (b) => Boolean(b.findBlock({ matching: (bl) => match(bl.name), maxDistance: 24 }))
        });
        if (!found) throw new Error("Ağaç bulunamadı (halka arama tükendi)");
        block = bot.findBlock({ matching: (b) => match(b.name), maxDistance: 32 });
      }
      if (!block) continue;

      await this.digBlock(bot, block, token);
      // sapling replant optional
      try {
        const sap = bot.inventory.items().find((i) => i.name.endsWith("_sapling"));
        if (sap) {
          const dirt = bot.blockAt(block.position.offset(0, -1, 0));
          if (dirt && (dirt.name.includes("dirt") || dirt.name.includes("grass"))) {
            await bot.equip(sap, "hand");
            await bot.placeBlock(dirt, new (await import("vec3")).Vec3(0, 1, 0));
          }
        }
      } catch {
        /* replant best-effort */
      }

      got = this.countItems(bot, (n) => (logType ? n === logType : LOG_BLOCKS.has(n) || n.endsWith("_log")));
      report({ done: Math.min(got, need), total: need, label: `odun ${got}/${need}` });
    }
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    this.log().success(`Odun toplama bitti (${got})`);
  }

  async runCollectDrops(filter: string | undefined, radius: number, token: TaskToken, report: ProgressFn) {
    const picked = await runSmartCollectDrops(this.instance, filter, radius, token, report);
    this.log().success(`Yerdeki eşya toplama (doğrulandı: ${picked})`);
  }

  /** Blok/item adına göre akıllı ham madde + craft zinciri */

  async runCollectBlock(name: string, need: number, token: TaskToken, report: ProgressFn) {
    await runSmartCollectBlock(this.instance, name, need, token, report);
    this.log().success(`Kaynak toplama bitti: ${name} · hedef ${need}`);
  }

  async runMine(ore: string, need: number, mode: "legit" | "utility", token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    const oreName = ore.replace(/^minecraft:/, "");
    const blockNames = oreVariants(oreName);
    let got = this.countItems(bot, (n) => n.includes(oreName) || n === oreName + "_ingot" || n === "raw_" + oreName);
    report({ done: got, total: need, label: `${oreName} ${got}/${need}` });

    // tool
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const toolPlugin = require("mineflayer-tool").plugin;
      if (!(bot as unknown as { tool?: unknown }).tool) bot.loadPlugin(toolPlugin);
    } catch {
      /* optional */
    }

    while (got < need && !token.cancelled) {
      let block = bot.findBlock({
        matching: (b) => blockNames.some((n) => b.name.includes(n)),
        maxDistance: mode === "utility" ? 64 : 32
      });

      if (!block && mode === "legit") {
        // simple branch: dig down a bit if high, else horizontal dig sample
        const y = Math.floor(bot.entity.position.y);
        if (y > 20) {
          try {
            await runGoto(this.instance, bot.entity.position.x, Math.max(12, y - 8), bot.entity.position.z, 2, token, report);
          } catch {
            /* */
          }
        }
        const found = await ringSearch(this.instance, token, report, {
          step: 24,
          maxRadius: 96,
          probe: (b) =>
            Boolean(
              b.findBlock({
                matching: (bl) => blockNames.some((n) => bl.name.includes(n)),
                maxDistance: 16
              })
            )
        });
        if (!found) throw new Error(`${oreName} bulunamadı`);
        block = bot.findBlock({
          matching: (b) => blockNames.some((n) => b.name.includes(n)),
          maxDistance: 32
        });
      }

      if (!block) throw new Error(`${oreName} bloğu yok`);

      // safety: lava neighbor
      if (this.hasLavaNear(bot, block.position)) {
        this.log().warn("Lav yakını — blok atlandı");
        // dig a different path
        await sleep(500);
        continue;
      }

      await this.digBlock(bot, block, token);
      got = this.countItems(bot, (n) => n.includes(oreName) || n === "raw_" + oreName || n === oreName + "_ingot");
      report({ done: Math.min(got, need), total: need, label: `${oreName} ${got}/${need}` });
    }
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    this.log().success(`Madencilik bitti: ${oreName} ×${got}`);
  }

  private async digBlock(bot: Bot, block: { position: { x: number; y: number; z: number }; name: string }, token: TaskToken) {
    await runGoto(this.instance, block.position.x, block.position.y, block.position.z, 3, token, () => {});
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    ensureMovement(this.instance);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Vec3 = require("vec3");
    const pos = new Vec3(Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z));
    const blk = bot.blockAt(pos);
    if (!blk) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const toolPlugin = require("mineflayer-tool").plugin;
      if (!(bot as unknown as { tool?: unknown }).tool) bot.loadPlugin(toolPlugin);
      const toolBot = bot as unknown as { tool?: { equipForBlock(block: unknown): Promise<void> } };
      if (toolBot.tool) await toolBot.tool.equipForBlock(blk);
    } catch {
      /* no tool plugin */
    }
    if (bot.heldItem && this.instance.config.inventory.bannedItems.includes(bot.heldItem.name)) {
      throw new Error(`Eldeki alet yasaklı: ${bot.heldItem.name}`);
    }
    await bot.dig(blk);
    // Kazılan item entity'sini gerçekten envantere girene kadar takip et.
    await collectDropsAfterDig(this.instance, blk.name, token);
  }

  private hasLavaNear(bot: Bot, pos: { x: number; y: number; z: number }) {
    const Vec3 = require("vec3");
    for (const o of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1]
    ]) {
      const b = bot.blockAt(new Vec3(pos.x + o[0]!, pos.y + o[1]!, pos.z + o[2]!));
      if (b && (b.name === "lava" || b.name === "flowing_lava")) return true;
    }
    return false;
  }

  private countItems(bot: Bot, pred: (name: string) => boolean) {
    return bot.inventory.items().reduce((s, i) => s + (pred(i.name) ? i.count : 0), 0);
  }

  private requireBot(): Bot {
    const bot = this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot çevrimdışı");
    return bot;
  }
}

function oreVariants(ore: string): string[] {
  const o = ore.replace(/_ore$/, "");
  return [`${o}_ore`, `deepslate_${o}_ore`, `raw_${o}`, o];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export { ringSearch } from "./ringSearch";

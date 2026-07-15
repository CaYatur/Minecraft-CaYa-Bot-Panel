import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";

const MAX_DEPTH = 8;

export interface CraftPlanStep {
  kind: "gather" | "craft" | "smelt";
  item: string;
  count: number;
  note?: string;
}

/**
 * Craft chain (Faz 9): recipe tree + sequential craft attempts.
 * Gathering hooks into GatherService when raw materials missing.
 */
export class CraftService {
  constructor(private readonly instance: BotInstance) {}

  private log() {
    return this.instance.getLogger();
  }

  previewPlan(item: string, count = 1): CraftPlanStep[] {
    const bot = this.instance.bot;
    if (!bot) {
      // offline preview: heuristic tree
      return heuristicPlan(item, count);
    }
    return this.buildPlan(bot, item.replace(/^minecraft:/, ""), count, 0);
  }

  enqueueCraft(item: string, count = 1) {
    const name = item.replace(/^minecraft:/, "");
    const n = Math.max(1, Math.min(64, Math.floor(count)));
    return this.instance.tasks.enqueue(
      {
        type: "craft",
        label: `üret: ${name} ×${n}`,
        priority: PRIORITY.USER,
        params: { item: name, count: n },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCraft(name, n, token, report)
    );
  }

  /** Build/acquire içinden kuyruğa almadan craft dene */
  async runCraftInline(item: string, count: number, token: TaskToken, report: ProgressFn) {
    const name = item.replace(/^minecraft:/, "");
    const n = Math.max(1, Math.min(64, Math.floor(count)));
    await this.runCraft(name, n, token, report);
  }

  /** Tarif var mı? (2x2 / masa) */
  canCraft(item: string): boolean {
    const bot = this.instance.bot;
    if (!bot) return false;
    const name = item.replace(/^minecraft:/, "");
    const id = bot.registry.itemsByName[name]?.id;
    if (id == null) return false;
    const r1 = bot.recipesFor(id, null, 1, null) as unknown[];
    if (r1.length) return true;
    const r2 = bot.recipesFor(id, null, 1, true) as unknown[];
    return r2.length > 0;
  }

  private buildPlan(bot: Bot, item: string, count: number, depth: number): CraftPlanStep[] {
    if (depth > MAX_DEPTH) return [{ kind: "gather", item, count, note: "derinlik sınırı" }];
    const id = bot.registry.itemsByName[item]?.id;
    if (id == null) return [{ kind: "gather", item, count, note: "bilinmeyen eşya" }];

    const have = bot.inventory.items().filter((i) => i.name === item).reduce((s, i) => s + i.count, 0);
    if (have >= count) return [];

    const need = count - have;
    const recipes = bot.recipesFor(id, null, 1, null) as Array<{
      delta?: Array<{ id: number; count: number }>;
      result?: { name?: string };
    }>;

    if (!recipes.length) {
      if (item.endsWith("_ingot")) return [{ kind: "smelt", item, count: need }];
      if (item.includes("log") || item === "cobblestone" || item === "dirt") return [{ kind: "gather", item, count: need }];
      return [{ kind: "gather", item, count: need }];
    }

    const recipe = recipes[0]!;
    const steps: CraftPlanStep[] = [];
    // rough: ensure ingredients
    const delta = recipe.delta ?? [];
    for (const d of delta) {
      if (d.count >= 0) continue; // result
      const ingName = bot.registry.items[d.id]?.name;
      if (!ingName) continue;
      const ingNeed = Math.abs(d.count) * need;
      steps.push(...this.buildPlan(bot, ingName, ingNeed, depth + 1));
    }
    steps.push({ kind: "craft", item, count: need });
    return steps;
  }

  private async runCraft(item: string, count: number, token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    const plan = this.buildPlan(bot, item, count, 0);
    report({ done: 0, total: Math.max(1, plan.length), label: `plan: ${plan.length} adım` });
    this.log().info(`Üretim planı: ${item}×${count}`, plan.map((p) => `${p.kind}:${p.item}×${p.count}`).join(" → "));

    let stepI = 0;
    for (const step of plan) {
      if (token.cancelled) throw new Error(token.reason ?? "iptal");
      stepI++;
      const stepLabel =
        step.kind === "craft"
          ? `Craft: ${step.item} ×${step.count}`
          : step.kind === "smelt"
            ? `Eritiliyor: ${step.item} ×${step.count}`
            : `Toplanıyor: ${step.item} ×${step.count}`;
      report({ done: stepI - 1, total: plan.length, label: stepLabel });

      if (step.kind === "gather") {
        await this.gatherFallback(step.item, step.count, token, report);
      } else if (step.kind === "smelt") {
        try {
          await this.instance.survival["runCook"]?.(token, report);
        } catch {
          this.log().warn("Smelt adımı atlandı");
        }
      } else if (step.kind === "craft") {
        report({ done: stepI - 1, total: plan.length, label: `Craft deneniyor: ${step.item} ×${step.count}` });
        await this.craftItem(bot, step.item, step.count, token);
      }
    }

    const have = bot.inventory.items().filter((i) => i.name === item).reduce((s, i) => s + i.count, 0);
    if (have < count) {
      // final direct craft attempt
      report({ done: plan.length, total: plan.length, label: `Craft deneniyor: ${item} ×${count}` });
      await this.craftItem(bot, item, count, token);
    }
    report({ done: plan.length, total: plan.length, label: `Craft bitti: ${item}` });
    this.log().success(`Üretim bitti: ${item}`);
  }

  private async gatherFallback(item: string, count: number, token: TaskToken, report: ProgressFn) {
    if (item.includes("log") || item.includes("planks") || item === "stick") {
      const wood = Math.max(count, item === "stick" ? Math.ceil(count / 4) : count);
      await this.instance.gather.runCollectWood(wood, item.endsWith("_log") ? item : undefined, token, report);
      if (item === "stick" || item.includes("planks")) {
        await this.craftItem(this.requireBot(), item.includes("planks") ? item : "oak_planks", Math.max(1, Math.ceil(count / 2)), token);
        if (item === "stick") await this.craftItem(this.requireBot(), "stick", count, token);
      }
      return;
    }
    if (item.includes("ore") || item === "cobblestone" || item === "stone" || item === "iron_ingot") {
      // Nested enqueue tamamlanmayı beklemez — plan adımında kullanıcıya net uyarı
      this.log().warn(
        `Craft planı için ${item}×${count} envanterde yok; önce maden-topla / el ile temin et (iç içe kuyruk beklenmez)`
      );
      return;
    }
    this.log().warn(`Toplama planı karşılanamadı: ${item}×${count}`);
  }

  private async craftItem(bot: Bot, item: string, count: number, token: TaskToken) {
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    const id = bot.registry.itemsByName[item]?.id;
    if (id == null) throw new Error(`Eşya bilinmiyor: ${item}`);

    let left = count;
    let guard = 0;
    while (left > 0 && guard++ < 30) {
      const have = bot.inventory.items().filter((i) => i.name === item).reduce((s, i) => s + i.count, 0);
      if (have >= count) return;

      let recipes = bot.recipesFor(id, null, 1, null) as unknown[];
      if (!recipes.length) {
        try {
          await this.ensureCraftingTable(bot, token);
        } catch {
          /* table optional */
        }
        recipes = bot.recipesFor(id, null, 1, true) as unknown[];
      }
      if (!recipes.length) throw new Error(`Tarif bulunamadı: ${item}`);
      try {
        await bot.craft(recipes[0] as never, 1, undefined);
        left--;
      } catch (e) {
        throw new Error(`Craft başarısız ${item}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private async ensureCraftingTable(bot: Bot, token: TaskToken) {
    const planks = bot.inventory.items().filter((i) => i.name.endsWith("_planks")).reduce((s, i) => s + i.count, 0);
    if (planks < 4) {
      // craft planks from log
      const log = bot.inventory.items().find((i) => i.name.endsWith("_log"));
      if (!log) throw new Error("Kereste için kütük yok");
      const plankName = log.name.replace("_log", "_planks");
      const pid = bot.registry.itemsByName[plankName]?.id;
      if (pid == null) throw new Error("plank id yok");
      const r = bot.recipesFor(pid, null, 1, null);
      if (!r.length) throw new Error("plank tarifi yok");
      await bot.craft(r[0]!, 1, undefined);
    }
    const tid = bot.registry.itemsByName.crafting_table?.id;
    if (tid == null) throw new Error("crafting_table yok");
    const tr = bot.recipesFor(tid, null, 1, null);
    if (!tr.length) throw new Error("masa tarifi yok");
    await bot.craft(tr[0]!, 1, undefined);
    const item = bot.inventory.items().find((i) => i.name === "crafting_table");
    if (!item) throw new Error("masa craft edilemedi");
    const base = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!base) throw new Error("yerleştirme yüzeyi yok");
    await bot.equip(item, "hand");
    // place on top of block under feet offset
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Vec3 = require("vec3");
      await bot.placeBlock(base, new Vec3(0, 1, 0));
    } catch (e) {
      throw new Error(`Masa yerleştirilemedi: ${e instanceof Error ? e.message : e}`);
    }
    void token;
  }

  private requireBot(): Bot {
    const bot = this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot çevrimdışı");
    return bot;
  }
}

function heuristicPlan(item: string, count: number): CraftPlanStep[] {
  if (item === "stick") return [{ kind: "gather", item: "oak_log", count: 1 }, { kind: "craft", item: "oak_planks", count: 2 }, { kind: "craft", item: "stick", count }];
  if (item.includes("pickaxe") || item.includes("sword") || item.includes("axe")) {
    const mat = item.split("_")[0] ?? "wooden";
    return [
      { kind: "gather", item: "oak_log", count: 3 },
      { kind: "craft", item: "oak_planks", count: 8 },
      { kind: "craft", item: "stick", count: 2 },
      ...(mat === "stone" || mat === "iron" || mat === "diamond"
        ? [{ kind: "gather" as const, item: mat === "stone" ? "cobblestone" : mat + "_ore", count: 3 }]
        : []),
      { kind: "craft", item, count }
    ];
  }
  return [{ kind: "craft", item, count }];
}

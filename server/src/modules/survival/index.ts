import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { ensureMovement, runGoto } from "../movement";
import { tryRealisticAttack, inMeleeRange, distanceEyeToEntity } from "../combat/realism";
import { BucketScoopService } from "./bucketScoop";
import { FallGuardService, type FallGuardState } from "./fallGuard";
import { foodScore, isFood, isRawMeat, HUNTABLE, RAW_TO_COOKED, FUEL_PRIORITY } from "./foods";
import { HazardGuardService, type HazardGuardState } from "./hazardGuard";
import { WaterGuardService, type WaterGuardState } from "./waterGuard";

/**
 * Survival brain (Faz 7): auto-eat, hunt nearby animals, simple furnace cook.
 * FallGuard: düşüş MLG · WaterGuard: boğulmama · HazardGuard: fire/lava · BucketScoop: boş kova doldur.
 */
export class SurvivalService {
  private bot: Bot | null = null;
  private eating = false;
  private lastEatAt = 0;
  private healthHook: (() => void) | null = null;
  private lastSwing = { t: 0 };
  readonly fallGuard: FallGuardService;
  readonly waterGuard: WaterGuardService;
  readonly hazardGuard: HazardGuardService;
  readonly bucketScoop: BucketScoopService;

  constructor(private readonly instance: BotInstance) {
    this.fallGuard = new FallGuardService(instance);
    this.waterGuard = new WaterGuardService(instance);
    this.hazardGuard = new HazardGuardService(instance);
    this.bucketScoop = new BucketScoopService(instance);
  }

  attach(bot: Bot) {
    this.detach();
    this.bot = bot;
    this.healthHook = () => void this.maybeAutoEat();
    bot.on("health", this.healthHook);
    this.fallGuard.attach(bot);
    this.waterGuard.attach(bot);
    this.hazardGuard.attach(bot);
    this.bucketScoop.attach(bot);
  }

  detach() {
    this.bucketScoop.detach();
    this.hazardGuard.detach();
    this.waterGuard.detach();
    this.fallGuard.detach();
    if (this.bot && this.healthHook) this.bot.removeListener("health", this.healthHook);
    this.healthHook = null;
    this.bot = null;
  }

  getFallGuardState(): FallGuardState {
    return this.fallGuard.getState();
  }

  getWaterGuardState(): WaterGuardState {
    return this.waterGuard.getState();
  }

  getHazardGuardState(): HazardGuardState {
    return this.hazardGuard.getState();
  }

  private cfg() {
    return this.instance.config.survival;
  }

  private log() {
    return this.instance.getLogger();
  }

  private banned() {
    return this.instance.config.inventory.bannedItems;
  }

  async maybeAutoEat(): Promise<boolean> {
    if (!this.cfg().autoEat) return false;
    const bot = this.bot;
    if (!bot || this.instance.status !== "online" || this.eating) return false;

    const food = bot.food ?? 20;
    const health = bot.health ?? 20;
    const threshold = this.cfg().eatAtFood ?? 14;
    const combatBusy = this.instance.combat.getRuntime().fighting;

    // tok — yeme dene (spam "Food is full" engeli)
    if (food >= 20) return false;
    // combatte: sadece can kritikse ye (silahı kaptırmasın)
    if (combatBusy && health > 8) return false;
    if (food > threshold && !(combatBusy && health <= 8)) return false;
    if (Date.now() - this.lastEatAt < 2500) return false;

    return this.eatBest();
  }

  async eatBest(): Promise<boolean> {
    const bot = this.bot ?? this.instance.bot;
    if (!bot || this.instance.status !== "online") return false;

    // Minecraft food 20 = tok; consume "Food is full" atar
    const foodLevel = bot.food ?? 20;
    if (foodLevel >= 20) {
      this.lastEatAt = Date.now();
      return false;
    }

    const blacklist = this.cfg().foodBlacklist ?? [];
    const banned = this.banned();

    const candidates = bot.inventory
      .items()
      .filter((i) => isFood(i.name) && !blacklist.includes(i.name) && !banned.includes(i.name))
      .sort((a, b) => foodScore(b.name) - foodScore(a.name));

    const item = candidates[0];
    if (!item) {
      this.log().debug("Yenilecek yiyecek yok");
      return false;
    }

    this.eating = true;
    try {
      await bot.equip(item, "hand");
      await bot.consume();
      this.lastEatAt = Date.now();
      this.log().success(`Yendi: ${item.displayName ?? item.name}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastEatAt = Date.now();
      // tok spam'i log boğmasın
      if (/food is full|not hungry|cannot eat/i.test(msg)) {
        this.log().debug("Eating skipped", msg);
      } else {
        this.log().warn("Yeme failed", msg);
      }
      return false;
    } finally {
      this.eating = false;
    }
  }

  enqueueEatNow() {
    return this.instance.tasks.enqueue(
      { type: "eat", label: "eat now", priority: PRIORITY.SURVIVAL, params: {}, requeueOnPreempt: false },
      () => async (token, report) => {
        report({ done: 0, total: 1, label: "yeniyor…" });
        const ok = await this.eatBest();
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        if (!ok) throw new Error("No suitable food (blacklist/banned/empty)");
        report({ done: 1, total: 1, label: "yendi" });
      }
    );
  }

  enqueueHunt(radius = 32) {
    const r = Math.max(8, Math.min(64, Math.floor(radius)));
    return this.instance.tasks.enqueue(
      { type: "hunt", label: `avlan (r=${r})`, priority: PRIORITY.AUTO, params: { radius: r }, requeueOnPreempt: true },
      () => (token, report) => this.runHunt(r, token, report)
    );
  }

  enqueueCook() {
    return this.instance.tasks.enqueue(
      { type: "cook", label: "cook raw meat", priority: PRIORITY.AUTO, params: {}, requeueOnPreempt: true },
      () => (token, report) => this.runCook(token, report)
    );
  }

  enqueueAcquireFood() {
    return this.instance.tasks.enqueue(
      { type: "acquire-food", label: "yemek edin", priority: PRIORITY.AUTO, params: {}, requeueOnPreempt: true },
      () => async (token, report) => {
        report({ done: 0, total: 3, label: "avlan…" });
        await this.runHunt(40, token, report);
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        report({ done: 1, total: 3, label: "cooking…" });
        try {
          await this.runCook(token, report);
        } catch {
          this.log().info("Cooking skipped or no furnace — mmainging with raw meat");
        }
        report({ done: 2, total: 3, label: "ye…" });
        await this.eatBest();
        report({ done: 3, total: 3, label: "yemek edin bitti" });
      }
    );
  }

  private async runHunt(radius: number, token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    await this.instance.combat.equipBestWeapon();
    const started = Date.now();
    let kills = 0;

    while (!token.cancelled && Date.now() - started < 5 * 60_000 && kills < 3) {
      const animal = this.nearestAnimal(radius);
      if (!animal) {
        report({ done: kills, total: 3, label: "no animals nearby" });
        if (kills === 0) throw new Error("No hunt animals nearby");
        break;
      }
      const name = String(animal.name ?? "animal").replace(/^minecraft:/, "");
      report({ done: kills, total: 3, label: `av: ${name}` });

      if (!inMeleeRange(bot, animal, this.instance.config.combat.reach)) {
        try {
          ensureMovement(this.instance);
          const { goals } = await import("mineflayer-pathfinder");
          bot.pathfinder.setGoal(new goals.GoalFollow(animal, 2), true);
          const t0 = Date.now();
          while (!token.cancelled && Date.now() - t0 < 20_000 && animal.isValid) {
            if (inMeleeRange(bot, animal, this.instance.config.combat.reach)) break;
            await sleep(200);
          }
          bot.pathfinder.setGoal(null);
        } catch {
          /* approach fail */
        }
      }

      if (!animal.isValid) continue;
      const res = await tryRealisticAttack(bot, animal, this.instance.config.combat, this.lastSwing, token);
      if (res.ok && (!animal.isValid || (animal.health !== undefined && animal.health <= 0))) {
        kills++;
        await sleep(800); // loot drop
      } else if (!res.ok && res.reason === "cancelled") throw new Error(token.reason ?? "cancelled");
      await sleep(100);
    }

    // pickup nearby drops briefly by standing
    await sleep(1500);
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    this.log().success(`Av bitti (${kills} hayvan)`);
  }

  async runCook(token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    const raw = bot.inventory.items().find((i) => isRawMeat(i.name) && RAW_TO_COOKED[i.name]);
    if (!raw) throw new Error("No raw meat to cook");

    report({ done: 0, total: 1, label: "looking for furnace" });
    const furnace = bot.findBlock({
      matching: (b) => ["furnace", "smoker", "blast_furnace"].includes(b.name),
      maxDistance: 32
    });

    if (!furnace) {
      // try craft+place furnace if we have materials
      const hasCobble = bot.inventory.items().filter((i) => i.name === "cobblestone").reduce((s, i) => s + i.count, 0);
      if (hasCobble >= 8) {
        try {
          await this.craftSimple(bot, "furnace", 1);
          const block = bot.blockAt(bot.entity.position.offset(0, -1, 1).floored());
          if (block) {
            const furnItem = bot.inventory.items().find((i) => i.name === "furnace");
            if (furnItem) {
              await bot.equip(furnItem, "hand");
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const Vec3 = require("vec3");
              await bot.placeBlock(block, new Vec3(0, 1, 0));
            }
          }
        } catch (e) {
          throw new Error(`No furnace and could not place one: ${e instanceof Error ? e.message : e}`);
        }
      } else {
        throw new Error("No furnace nearby and not enough cobblestone");
      }
    }

    const furn = bot.findBlock({
      matching: (b) => ["furnace", "smoker", "blast_furnace"].includes(b.name),
      maxDistance: 32
    });
    if (!furn) throw new Error("Furnace not found");

    await runGoto(this.instance, furn.position.x, furn.position.y, furn.position.z, 2, token, report);
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");

    report({ done: 0, total: 1, label: "smelting" });
    try {
      const win = await bot.openFurnace(furn);
      const fuel =
        bot.inventory.items().find((i) => FUEL_PRIORITY.includes(i.name)) ??
        bot.inventory.items().find((i) => i.name.includes("log") || i.name.includes("planks"));
      const rawNow = bot.inventory.items().find((i) => isRawMeat(i.name));
      if (rawNow) await win.putInput(rawNow.type, null, Math.min(8, rawNow.count));
      if (fuel) await win.putFuel(fuel.type, null, Math.min(4, fuel.count));
      // wait for cook
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000 && !token.cancelled) {
        await sleep(1000);
        try {
          await win.takeOutput();
        } catch {
          /* not ready */
        }
        if (!bot.inventory.items().some((i) => isRawMeat(i.name))) break;
      }
      win.close();
    } catch (e) {
      throw new Error(`Furnace use failed: ${e instanceof Error ? e.message : e}`);
    }
    this.log().success("Cook attempt done");
  }

  private async craftSimple(bot: Bot, name: string, count: number) {
    const recipes = bot.recipesFor(bot.registry.itemsByName[name]?.id, null, 1, null);
    if (!recipes.length) throw new Error(`Tarif yok: ${name}`);
    await bot.craft(recipes[0]!, count, undefined);
  }

  private nearestAnimal(radius: number) {
    const bot = this.bot;
    if (!bot) return null;
    let best: import("prismarine-entity").Entity | null = null;
    let bestD = radius;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      const n = String(e.name ?? "").replace(/^minecraft:/, "");
      if (!HUNTABLE.has(n)) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private requireBot(): Bot {
    const bot = this.bot ?? this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot offline");
    this.bot = bot;
    return bot;
  }

  /** low food → queue acquire if idle-ish */
  tickFoodWatch() {
    const bot = this.bot;
    if (!bot || !this.cfg().autoEat) return;
    if ((bot.food ?? 20) > 6) return;
    const hasFood = bot.inventory.items().some((i) => isFood(i.name) && !(this.cfg().foodBlacklist ?? []).includes(i.name));
    if (hasFood) return;
    const cur = this.instance.tasks.currentSummary;
    if (cur && (cur.type === "acquire-food" || cur.type === "hunt" || cur.type === "cook")) return;
    this.log().info("No food and low hunger — acquire-food task queued");
    try {
      this.enqueueAcquireFood();
    } catch {
      /* queue busy */
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export { foodScore, isFood, HUNTABLE } from "./foods";

import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { creativeEnsureItem, isCreativeMode } from "../build/creative";
import { boundedOp, digCancelable, pathNear } from "../build/place";
import { runSmartCollectDrops } from "../gather/smartGather";
import { depositToChest } from "../inventory/chestOps";
import {
  CROPS,
  cropForSeed,
  FARM_PRODUCE,
  HOE_ORDER,
  isMatureCrop,
  seedForCrop,
  TILLABLE
} from "./crops";

/**
 * Issue #5 — tarım (Faz 19). Çapalama, ekim, hasat ve sürekli tarım döngüsü.
 * Tek paylaşılan çekirdek; MCP/Ollama araçları, otomasyon RuleEngine aksiyonları
 * ve panel aynı TaskQueue işlerini kullanır (İ2 gerçekçilik: çapa eldedir,
 * activateBlock/placeBlock ile oynanır — hile yok; İ6: iptal/öncelik uyumlu).
 */

export interface FarmArea {
  /** merkez (verilmezse bot konumu) */
  x?: number;
  y?: number;
  z?: number;
  /** yarıçap 1–16 (default 6) */
  radius?: number;
}

export interface TillOpts extends FarmArea {
  maxBlocks?: number;
}

export interface PlantOpts extends FarmArea {
  /** wheat_seeds | carrot | potato | beetroot_seeds | melon_seeds | pumpkin_seeds */
  crop?: string;
  maxBlocks?: number;
}

export interface HarvestOpts extends FarmArea {
  replant?: boolean;
  maxBlocks?: number;
}

export interface FarmCycleOpts extends FarmArea {
  crop?: string;
  /** hasat sonrası yeniden ek (default true) */
  replant?: boolean;
  /** gerekiyorsa alandaki toprağı çapala (default true) */
  till?: boolean;
  /** ürünleri bu sandığa bırak (yoksa depolamayı atla) */
  depositX?: number;
  depositY?: number;
  depositZ?: number;
  /** yakındaki HERHANGİ bir sandığa bırak (koordinat verilmediyse) */
  depositNearest?: boolean;
  /** turlar arası bekleme sn (default 45, min 10) */
  intervalSec?: number;
  /** N tur sonra dur; 0/undefined = durdurulana dek sürekli */
  maxCycles?: number;
}

const REACH = 4.2;
const AREA_MAX_R = 16;

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline");
  return bot;
}

function sleepCancellable(ms: number, token: TaskToken): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (token.cancelled) return reject(new Error(token.reason ?? "cancelled"));
      if (Date.now() - t0 >= ms) return resolve();
      setTimeout(tick, Math.min(250, ms));
    };
    tick();
  });
}

function areaCenter(instance: BotInstance, area: FarmArea): { x: number; y: number; z: number; r: number } {
  const bot = requireBot(instance);
  const p = bot.entity.position;
  return {
    x: Math.floor(area.x ?? p.x),
    y: Math.floor(area.y ?? p.y),
    z: Math.floor(area.z ?? p.z),
    r: Math.max(1, Math.min(AREA_MAX_R, Math.floor(area.radius ?? 6)))
  };
}

/** alan tarama — merkez etrafında r yarıçap, y ±2 katman */
function scanArea(
  bot: Bot,
  c: { x: number; y: number; z: number; r: number },
  match: (block: Block, above: Block | null) => boolean,
  max: number
): Block[] {
  const out: Block[] = [];
  for (let dy = 2; dy >= -2; dy--) {
    for (let dx = -c.r; dx <= c.r; dx++) {
      for (let dz = -c.r; dz <= c.r; dz++) {
        if (dx * dx + dz * dz > c.r * c.r + 1) continue;
        const v = new Vec3(c.x + dx, c.y + dy, c.z + dz);
        const b = bot.blockAt(v);
        if (!b) continue;
        const above = bot.blockAt(v.offset(0, 1, 0));
        if (match(b, above)) {
          out.push(b);
          if (out.length >= max * 3) return out; // yeterli aday
        }
      }
    }
  }
  const p = bot.entity.position;
  out.sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p));
  return out.slice(0, max);
}

function isAirLike(b: Block | null): boolean {
  if (!b) return false;
  return b.name === "air" || b.name === "cave_air" || b.name === "short_grass" || b.name === "grass" || b.name === "tall_grass" || b.name === "snow";
}

/** ekime uygun ıslak/kuru farmland üstü boş hücre */
function isPlantableFarmland(b: Block, above: Block | null): boolean {
  return b.name === "farmland" && (above?.name === "air" || above?.name === "cave_air");
}

export class FarmService {
  constructor(private readonly instance: BotInstance) {}

  private log() {
    return this.instance.getLogger();
  }

  // ---------------------------------------------------------------- hoe / seeds

  /** eldeki en iyi çapa; yoksa craft zinciri (survival) veya conjure (creative) */
  private async ensureHoe(token: TaskToken, report: ProgressFn): Promise<string> {
    const bot = requireBot(this.instance);
    const find = () => {
      for (const h of HOE_ORDER) {
        const it = bot.inventory.items().find((i) => i.name === h);
        if (it) return it;
      }
      return null;
    };
    let hoe = find();
    if (!hoe && isCreativeMode(bot)) {
      await creativeEnsureItem(bot, "iron_hoe", 1);
      hoe = find();
    }
    if (!hoe) {
      // survival: tahta/taş çapa craft zinciri (malzeme varsa)
      for (const target of ["stone_hoe", "wooden_hoe"]) {
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        if (!this.instance.craft.canCraft(target)) continue;
        try {
          report({ done: 0, total: 1, label: `crafting ${target}` });
          await this.instance.craft.runCraftInline(target, 1, token, report);
        } catch (e) {
          if (token.cancelled) throw e;
        }
        hoe = find();
        if (hoe) break;
      }
    }
    if (!hoe) {
      throw new Error("No hoe and none craftable (need planks/sticks or stone). Craft a hoe first, e.g. wooden_hoe.");
    }
    await boundedOp(bot.equip(hoe, "hand"), token, 5_000, "equip hoe");
    return hoe.name;
  }

  /** tohumu güvence altına al: envanter → creative conjure; yoksa dürüst hata */
  private async ensureSeeds(seed: string, token: TaskToken): Promise<number> {
    const bot = requireBot(this.instance);
    const count = () => bot.inventory.items().reduce((s, i) => s + (i.name === seed ? i.count : 0), 0);
    if (count() > 0) return count();
    if (isCreativeMode(bot)) {
      await creativeEnsureItem(bot, seed, 16);
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    }
    return count();
  }

  // ---------------------------------------------------------------- primitives

  /** tek hücreyi çapala (coarse/rooted dirt 2 kez right-click ister) */
  private async tillCell(block: Block, token: TaskToken): Promise<"tilled" | "failed"> {
    const bot = requireBot(this.instance);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      const cur = bot.blockAt(block.position);
      if (!cur) return "failed";
      if (cur.name === "farmland") return "tilled";
      if (!TILLABLE.has(cur.name)) return "failed";
      // üstü kapalıysa çapalanamaz (çim gibi kırılabilirler placeBlock ile değil dig ile temizlenir)
      const above = bot.blockAt(block.position.offset(0, 1, 0));
      if (above && !isAirLike(above)) {
        if (above.name === "short_grass" || above.name === "grass" || above.name === "tall_grass" || above.name === "snow") {
          try {
            await digCancelable(bot, above, token);
          } catch (e) {
            if (token.cancelled) throw e;
            return "failed";
          }
        } else {
          return "failed";
        }
      }
      try {
        await boundedOp(bot.lookAt(block.position.offset(0.5, 1, 0.5), true), token, 2_000, "look");
        await boundedOp(bot.activateBlock(cur), token, 4_000, "till (use hoe)");
      } catch (e) {
        if (token.cancelled) throw e;
        return "failed";
      }
      await sleepCancellable(150, token);
    }
    const after = bot.blockAt(block.position);
    return after?.name === "farmland" ? "tilled" : "failed";
  }

  /** farmland üstüne tohum ek */
  private async plantCell(farmland: Block, seed: string, token: TaskToken): Promise<"planted" | "failed"> {
    const bot = requireBot(this.instance);
    const item = bot.inventory.items().find((i) => i.name === seed);
    if (!item) return "failed";
    try {
      await boundedOp(bot.equip(item, "hand"), token, 5_000, "equip seeds");
      await boundedOp(bot.lookAt(farmland.position.offset(0.5, 1, 0.5), true), token, 2_000, "look");
      await boundedOp(bot.placeBlock(farmland, new Vec3(0, 1, 0)), token, 4_000, `plant ${seed}`);
    } catch (e) {
      if (token.cancelled) throw e;
      // placeBlock bazen blok güncellemesini kaçırır — dünyadan doğrula
    }
    await sleepCancellable(120, token);
    const above = bot.blockAt(farmland.position.offset(0, 1, 0));
    return above && CROPS[above.name] ? "planted" : "failed";
  }

  // ---------------------------------------------------------------- runs

  /** çapalama koşusu: alandaki tüm uygun toprakları farmland yap */
  async runTill(opts: TillOpts, token: TaskToken, report: ProgressFn): Promise<string> {
    const bot = requireBot(this.instance);
    const c = areaCenter(this.instance, opts);
    const max = Math.max(1, Math.min(256, opts.maxBlocks ?? 128));
    const cells = scanArea(bot, c, (b, above) => TILLABLE.has(b.name) && (isAirLike(above) || above == null), max);
    if (!cells.length) {
      return `No tillable soil (dirt/grass/dirt_path) within r=${c.r} of ${c.x},${c.y},${c.z}.`;
    }
    const hoeName = await this.ensureHoe(token, report);
    let tilled = 0;
    let failed = 0;
    for (let i = 0; i < cells.length; i++) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      const cell = cells[i]!;
      report({ done: i, total: cells.length, label: `till ${cell.position.x},${cell.position.y},${cell.position.z}` });
      const d = bot.entity.position.distanceTo(cell.position.offset(0.5, 1, 0.5));
      if (d > REACH) {
        try {
          await pathNear(this.instance, cell.position.x + 0.5, cell.position.y + 1, cell.position.z + 0.5, 2.5, token, {
            clearGoal: true,
            timeoutMs: 8_000
          });
        } catch (e) {
          if (token.cancelled) throw e;
          failed++;
          continue;
        }
      }
      // çapa elde kalsın (yol sırasında değişmiş olabilir)
      const held = bot.heldItem?.name ?? "";
      if (!held.endsWith("_hoe")) await this.ensureHoe(token, report);
      const res = await this.tillCell(cell, token);
      if (res === "tilled") tilled++;
      else failed++;
    }
    const hydro = this.hydrationWarning(bot, c);
    const msg = `Tilled ${tilled}/${cells.length} block(s) with ${hoeName}${failed ? ` · ${failed} failed/skipped` : ""}.${hydro}`;
    this.log().info("Till finished", msg);
    report({ done: cells.length, total: cells.length, label: `tilled ${tilled}` });
    return msg;
  }

  /** alandaki farmland'lerin 4 blok içinde su var mı — yoksa uyarı metni */
  private hydrationWarning(bot: Bot, c: { x: number; y: number; z: number; r: number }): string {
    const water = bot.findBlock({
      matching: (b) => b.name === "water",
      maxDistance: c.r + 6,
      point: new Vec3(c.x, c.y, c.z)
    });
    return water ? "" : " WARNING: no water nearby — dry farmland reverts to dirt (place water within 4 blocks).";
  }

  /** ekim koşusu */
  async runPlant(opts: PlantOpts, token: TaskToken, report: ProgressFn): Promise<string> {
    const bot = requireBot(this.instance);
    const c = areaCenter(this.instance, opts);
    const seed = seedForCrop(opts.crop ?? "wheat_seeds");
    const max = Math.max(1, Math.min(256, opts.maxBlocks ?? 128));
    const cells = scanArea(bot, c, (b, above) => isPlantableFarmland(b, above), max);
    if (!cells.length) return `No empty farmland within r=${c.r} — till first (till_soil).`;

    const have = await this.ensureSeeds(seed, token);
    if (have <= 0) {
      return `No ${seed} in inventory — harvest/collect some first (grass drops wheat_seeds; crops drop their own seeds).`;
    }
    let planted = 0;
    let failed = 0;
    for (let i = 0; i < cells.length; i++) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      if (!bot.inventory.items().some((it) => it.name === seed)) break; // tohum bitti
      const cell = cells[i]!;
      report({ done: i, total: cells.length, label: `plant ${seed} @${cell.position.x},${cell.position.z}` });
      const d = bot.entity.position.distanceTo(cell.position.offset(0.5, 1, 0.5));
      if (d > REACH) {
        try {
          await pathNear(this.instance, cell.position.x + 0.5, cell.position.y + 1, cell.position.z + 0.5, 2.5, token, {
            clearGoal: true,
            timeoutMs: 8_000
          });
        } catch (e) {
          if (token.cancelled) throw e;
          failed++;
          continue;
        }
      }
      const res = await this.plantCell(cell, seed, token);
      if (res === "planted") planted++;
      else failed++;
    }
    const msg = `Planted ${planted} ${seed}${failed ? ` · ${failed} failed` : ""}${planted < cells.length && !bot.inventory.items().some((it) => it.name === seed) ? " · ran out of seeds" : ""}.`;
    this.log().info("Plant finished", msg);
    report({ done: cells.length, total: cells.length, label: `planted ${planted}` });
    return msg;
  }

  /** hasat koşusu (olgun ekinler; opsiyonel yeniden ekim) */
  async runHarvest(opts: HarvestOpts, token: TaskToken, report: ProgressFn): Promise<string> {
    const bot = requireBot(this.instance);
    const c = areaCenter(this.instance, opts);
    const replant = opts.replant !== false;
    const max = Math.max(1, Math.min(256, opts.maxBlocks ?? 128));
    const cells = scanArea(bot, c, (b) => isMatureCrop(b), max);
    if (!cells.length) return `No mature crops within r=${c.r} of ${c.x},${c.y},${c.z} — they may still be growing.`;

    let harvested = 0;
    let replanted = 0;
    let failed = 0;
    for (let i = 0; i < cells.length; i++) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      const cell = cells[i]!;
      const cropName = cell.name;
      report({ done: i, total: cells.length, label: `harvest ${cropName} @${cell.position.x},${cell.position.z}` });
      const d = bot.entity.position.distanceTo(cell.position.offset(0.5, 0.5, 0.5));
      if (d > REACH) {
        try {
          await pathNear(this.instance, cell.position.x + 0.5, cell.position.y, cell.position.z + 0.5, 2.5, token, {
            clearGoal: true,
            timeoutMs: 8_000
          });
        } catch (e) {
          if (token.cancelled) throw e;
          failed++;
          continue;
        }
      }
      const live = bot.blockAt(cell.position);
      if (!live || !isMatureCrop(live)) continue; // biri önce kırdı
      try {
        await digCancelable(bot, live, token);
        harvested++;
      } catch (e) {
        if (token.cancelled) throw e;
        failed++;
        continue;
      }
      // yeniden ekim (drop'lar yerdeyken bile tohum envanterde olabilir)
      if (replant) {
        const under = bot.blockAt(cell.position.offset(0, -1, 0));
        const seed = cropForSeed(cropName);
        if (under && under.name === "farmland" && seed) {
          await this.ensureSeeds(seed, token);
          const res = await this.plantCell(under, seed, token).catch((e) => {
            if (token.cancelled) throw e;
            return "failed" as const;
          });
          if (res === "planted") replanted++;
        }
      }
      // her 8 hasatta bir hızlı yer süpürme (drop kaybolmasın)
      if (harvested % 8 === 0) {
        try {
          await runSmartCollectDrops(this.instance, undefined, 6, token, () => {}, 4_000);
        } catch (e) {
          if (token.cancelled) throw e;
        }
      }
    }
    // final süpürme
    try {
      await runSmartCollectDrops(this.instance, undefined, Math.min(c.r + 4, 12), token, () => {}, 8_000);
    } catch (e) {
      if (token.cancelled) throw e;
    }
    const msg = `Harvested ${harvested} crop(s)${replant ? `, replanted ${replanted}` : ""}${failed ? ` · ${failed} failed` : ""}.`;
    this.log().info("Harvest finished", msg);
    report({ done: cells.length, total: cells.length, label: `harvested ${harvested}` });
    return msg;
  }

  /**
   * Sürekli tarım döngüsü: (till) → hasat+yeniden ek → (sandığa depola) → bekle → tekrar.
   * maxCycles verilmezse Stop/Reset/stop_all'a kadar sürer (İ6 iptal dostu).
   */
  async runFarmCycle(opts: FarmCycleOpts, token: TaskToken, report: ProgressFn): Promise<void> {
    const c = areaCenter(this.instance, opts);
    const seed = seedForCrop(opts.crop ?? "wheat_seeds");
    const interval = Math.max(10, Math.min(3600, opts.intervalSec ?? 45)) * 1000;
    const maxCycles = Math.max(0, Math.floor(opts.maxCycles ?? 0));
    const doTill = opts.till !== false;
    const hasChest = opts.depositX != null && opts.depositY != null && opts.depositZ != null;
    const totals = new Map<string, number>();

    let cycle = 0;
    for (;;) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      cycle++;
      const cycLabel = maxCycles ? `${cycle}/${maxCycles}` : `${cycle}`;
      report({ done: cycle - 1, total: maxCycles || cycle, label: `farm cycle ${cycLabel}` });

      const bot = requireBot(this.instance);
      const countProduce = () => {
        const m = new Map<string, number>();
        for (const it of bot.inventory.items()) {
          if (FARM_PRODUCE.has(it.name)) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
        }
        return m;
      };
      const before = countProduce();

      // 1) toprak hazırlığı (yeni bozulan/çiğnenen hücreler dahil)
      if (doTill) {
        try {
          await this.runTill({ ...opts, x: c.x, y: c.y, z: c.z, radius: c.r, maxBlocks: 96 }, token, report);
        } catch (e) {
          if (token.cancelled) throw e;
          this.log().warn("Farm cycle: till step failed", e instanceof Error ? e.message : String(e));
        }
      }

      // 2) hasat + yeniden ekim
      try {
        await this.runHarvest({ ...opts, x: c.x, y: c.y, z: c.z, radius: c.r, replant: opts.replant !== false }, token, report);
      } catch (e) {
        if (token.cancelled) throw e;
        this.log().warn("Farm cycle: harvest step failed", e instanceof Error ? e.message : String(e));
      }

      // 3) boş farmland kalan yerlere ekim
      try {
        await this.runPlant({ ...opts, x: c.x, y: c.y, z: c.z, radius: c.r, crop: seed }, token, report);
      } catch (e) {
        if (token.cancelled) throw e;
        this.log().warn("Farm cycle: plant step failed", e instanceof Error ? e.message : String(e));
      }

      const after = countProduce();
      for (const [name, n] of after) {
        const gained = n - (before.get(name) ?? 0);
        if (gained > 0) totals.set(name, (totals.get(name) ?? 0) + gained);
      }

      // 4) depola: belirli sandık (veya depositNearest) — tohumları ekim için sakla
      const shouldDeposit = hasChest || opts.depositNearest;
      const produceNow = [...after.entries()].reduce((s, [, n]) => s + n, 0);
      if (shouldDeposit && produceNow > 0) {
        const keepCounts: Record<string, number> = {};
        // yeniden ekim stoğu: alan kadar tohum elde kalsın
        keepCounts[seed] = Math.min(64, (c.r * 2 + 1) ** 2);
        try {
          await depositToChest(
            this.instance,
            {
              x: hasChest ? opts.depositX : undefined,
              y: hasChest ? opts.depositY : undefined,
              z: hasChest ? opts.depositZ : undefined,
              items: [...FARM_PRODUCE],
              keepCounts
            },
            token,
            report
          );
          // sandık başından tarlaya dön
          await pathNear(this.instance, c.x + 0.5, c.y, c.z + 0.5, 3, token, { clearGoal: true, timeoutMs: 20_000 }).catch((e) => {
            if (token.cancelled) throw e;
          });
        } catch (e) {
          if (token.cancelled) throw e;
          this.log().warn("Farm cycle: deposit failed", e instanceof Error ? e.message : String(e));
        }
      }

      const totalTxt = [...totals.entries()].map(([n, v]) => `${n}×${v}`).join(", ") || "none yet";
      this.instance.getLogger().info(`Farm cycle ${cycLabel} done`, `yield so far: ${totalTxt}`);
      report({ done: cycle, total: maxCycles || cycle + 1, label: `cycle ${cycLabel} · yield: ${totalTxt.slice(0, 60)}` });

      if (maxCycles && cycle >= maxCycles) break;
      // 5) büyüme bekle (iptale 250ms içinde tepki verir)
      await sleepCancellable(interval, token);
    }
  }

  // ---------------------------------------------------------------- enqueue facades

  enqueueTill(opts: TillOpts, priority: number = PRIORITY.USER) {
    const r = Math.max(1, Math.min(AREA_MAX_R, Math.floor(opts.radius ?? 6)));
    return this.instance.tasks.enqueue(
      {
        type: "till",
        label: `till soil r=${r}${opts.x != null ? ` @${Math.floor(opts.x)},${Math.floor(opts.z ?? 0)}` : ""}`,
        priority,
        params: { ...opts },
        requeueOnPreempt: true
      },
      () => async (token, report) => {
        const msg = await this.runTill(opts, token, report);
        if (msg.startsWith("No ")) throw new Error(msg);
      }
    );
  }

  enqueuePlant(opts: PlantOpts, priority: number = PRIORITY.USER) {
    const seed = seedForCrop(opts.crop ?? "wheat_seeds");
    return this.instance.tasks.enqueue(
      {
        type: "plant",
        label: `plant ${seed} r=${Math.floor(opts.radius ?? 6)}`,
        priority,
        params: { ...opts },
        requeueOnPreempt: true
      },
      () => async (token, report) => {
        const msg = await this.runPlant(opts, token, report);
        if (msg.startsWith("No ")) throw new Error(msg);
      }
    );
  }

  enqueueHarvest(opts: HarvestOpts, priority: number = PRIORITY.USER) {
    return this.instance.tasks.enqueue(
      {
        type: "harvest",
        label: `harvest r=${Math.floor(opts.radius ?? 6)}${opts.replant === false ? "" : " +replant"}`,
        priority,
        params: { ...opts },
        requeueOnPreempt: true
      },
      () => async (token, report) => {
        await this.runHarvest(opts, token, report);
      }
    );
  }

  enqueueFarmCycle(opts: FarmCycleOpts, priority: number = PRIORITY.USER) {
    const seed = seedForCrop(opts.crop ?? "wheat_seeds");
    const chest =
      opts.depositX != null && opts.depositY != null && opts.depositZ != null
        ? ` → chest ${Math.floor(opts.depositX)},${Math.floor(opts.depositY)},${Math.floor(opts.depositZ)}`
        : opts.depositNearest
          ? " → nearest chest"
          : "";
    return this.instance.tasks.enqueue(
      {
        type: "farm-cycle",
        label: `farm ${seed} r=${Math.floor(opts.radius ?? 6)}${chest}${opts.maxCycles ? ` ×${opts.maxCycles}` : " (loop)"}`,
        priority,
        params: { ...opts },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runFarmCycle(opts, token, report)
    );
  }
}

export { CROPS, FARM_PRODUCE, seedForCrop } from "./crops";

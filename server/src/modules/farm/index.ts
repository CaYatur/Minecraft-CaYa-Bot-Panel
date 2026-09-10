import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { creativeEnsureItem, isCreativeMode } from "../build/creative";
import { boundedOp, digCancelable, pathNear } from "../build/place";
import { runSmartCollectDrops } from "../gather/smartGather";
import { depositToChest } from "../inventory/chestOps";
import { ensureMovement, type EnsureMovementOpts } from "../movement";
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
  /** yarıçap 1–32 (default 6) */
  radius?: number;
  /** named player — farm around that player's current position */
  player?: string;
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
const AREA_MAX_R = 32;

/** No sprint/parkour on farmland — jumping tramples crops (issue #17). */
const FARM_MOVE: EnsureMovementOpts = {
  allowSprintNow: false,
  parkour: false,
  canDig: false,
  allowPlace: false,
  canOpenDoors: true
};

function applyFarmMovement(instance: BotInstance) {
  const bot = ensureMovement(instance, FARM_MOVE);
  try {
    bot.setControlState("sprint", false);
  } catch {
    /* */
  }
  return bot;
}

function farmPathOpts(extra?: { clearGoal?: boolean; timeoutMs?: number }) {
  return {
    clearGoal: extra?.clearGoal ?? true,
    timeoutMs: extra?.timeoutMs ?? 8_000,
    movement: FARM_MOVE
  };
}

async function farmNear(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  range: number,
  token: TaskToken
) {
  const bot = applyFarmMovement(instance);
  const d = bot.entity.position.distanceTo({ x, y, z } as never);
  if (d <= range + 0.5) return;
  if (isCreativeMode(bot)) {
    const flyTo = (bot as unknown as { creative?: { flyTo?(v: Vec3): Promise<void> } }).creative?.flyTo;
    if (typeof flyTo === "function") {
      try {
        await boundedOp(flyTo.call((bot as unknown as { creative: unknown }).creative, new Vec3(x, y, z)), token, 10_000, "creative fly");
        return;
      } catch (e) {
        if (token.cancelled) throw e;
      }
    }
  }
  await pathNear(instance, x, y, z, range, token, farmPathOpts());
}

function isWaterBlockName(name: string): boolean {
  return name === "water" || name === "flowing_water";
}

function isRaining(bot: Bot): boolean {
  const b = bot as Bot & { isRaining?: boolean; rainState?: number };
  return Boolean(b.isRaining) || (b.rainState ?? 0) > 0;
}

/** Vanilla: water within 4 blocks horizontally (square), same Y or one above. */
function isFarmlandHydrated(bot: Bot, pos: Vec3): boolean {
  if (isRaining(bot)) return true;
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (const dy of [0, 1]) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (b && isWaterBlockName(b.name)) return true;
      }
    }
  }
  return false;
}

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

function resolveFarmAnchor(instance: BotInstance, area: FarmArea): { x: number; y: number; z: number } {
  const bot = requireBot(instance);
  if (area.player && area.player.trim()) {
    const want = area.player.trim().toLowerCase();
    const hit = Object.entries(bot.players ?? {}).find(([n]) => n.toLowerCase() === want);
    const pos = hit?.[1]?.entity?.position;
    if (!pos) {
      throw new Error(`Player "${area.player}" is not in range (no entity). Stand nearby or use coordinates.`);
    }
    return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  }
  if (area.x != null && area.z != null) {
    return {
      x: Math.floor(area.x),
      y: Math.floor(area.y ?? bot.entity.position.y),
      z: Math.floor(area.z)
    };
  }
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/** If the bot is flying (creative) or standing on a slab, snap to the dirt/farmland layer. */
function snapFarmY(bot: Bot, x: number, y: number, z: number): number {
  const start = Math.floor(y);
  for (let dy = 0; dy <= 32; dy++) {
    for (const y2 of dy === 0 ? [start] : [start - dy, start + dy]) {
      const b = bot.blockAt(new Vec3(x, y2, z));
      if (!b) continue;
      if (TILLABLE.has(b.name) || b.name === "farmland" || CROPS[b.name]) return y2;
    }
  }
  for (let y2 = start; y2 >= start - 48; y2--) {
    const b = bot.blockAt(new Vec3(x, y2, z));
    if (!b) continue;
    if (b.name === "air" || b.name === "cave_air" || isWaterBlockName(b.name)) continue;
    if (b.boundingBox === "block") return y2;
  }
  return start;
}

function areaCenter(instance: BotInstance, area: FarmArea): { x: number; y: number; z: number; r: number } {
  const bot = requireBot(instance);
  const a = resolveFarmAnchor(instance, area);
  return {
    x: a.x,
    y: snapFarmY(bot, a.x, a.y, a.z),
    z: a.z,
    r: Math.max(1, Math.min(AREA_MAX_R, Math.floor(area.radius ?? 6)))
  };
}

/** alan tarama — merkez etrafında r yarıçap, y ±6 katman (creative uçuş payı) */
function scanArea(
  bot: Bot,
  c: { x: number; y: number; z: number; r: number },
  match: (block: Block, above: Block | null) => boolean,
  max: number
): Block[] {
  const out: Block[] = [];
  for (let dy = 6; dy >= -6; dy--) {
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
        const live = bot.blockAt(block.position);
        if (!live || live.name === "farmland") return live?.name === "farmland" ? "tilled" : "failed";
        await boundedOp(bot.lookAt(live.position.offset(0.5, 1, 0.5), true), token, 2_000, "look");
        await boundedOp(bot.activateBlock(live), token, 4_000, "till (use hoe)");
        const afterUse = bot.blockAt(block.position);
        if (afterUse?.name !== "farmland") {
          try {
            bot.activateItem();
          } catch {
            /* */
          }
          await sleepCancellable(120, token);
        }
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

  /**
   * Place a water source in the plot (dig a 1-block hole at/near center) so
   * farmland stays hydrated. No-op if no water_bucket or a crop occupies the cell.
   */
  private async tryPlaceWaterSource(
    c: { x: number; y: number; z: number; r: number },
    token: TaskToken
  ): Promise<boolean> {
    const bot = requireBot(this.instance);
    if (this.instance.config.inventory.bannedItems.includes("water_bucket")) return false;
    if (isCreativeMode(bot)) {
      await creativeEnsureItem(bot, "water_bucket", 1);
    }
    const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
    if (!bucket) return false;

    const isGood = (b: Block | null): b is Block => {
      if (!b) return false;
      if (isWaterBlockName(b.name)) return false;
      if (!TILLABLE.has(b.name) && b.name !== "farmland") return false;
      const above = bot.blockAt(b.position.offset(0, 1, 0));
      if (above && CROPS[above.name]) return false;
      return true;
    };

    let dest: Block | null = bot.blockAt(new Vec3(c.x, c.y, c.z));
    if (!isGood(dest)) {
      dest = scanArea(bot, c, (b, above) => isGood(b) && !(above && CROPS[above.name]), 8)[0] ?? null;
    }
    if (!dest) return false;

    const d = bot.entity.position.distanceTo(dest.position.offset(0.5, 1, 0.5));
    if (d > REACH) {
      await farmNear(
        this.instance,
        dest.position.x + 0.5,
        dest.position.y + 1,
        dest.position.z + 0.5,
        2.5,
        token
      );
    }

    const live = bot.blockAt(dest.position);
    if (!live) return false;
    if (isWaterBlockName(live.name)) return true;

    const above = bot.blockAt(live.position.offset(0, 1, 0));
    if (
      above &&
      (above.name === "short_grass" ||
        above.name === "grass" ||
        above.name === "tall_grass" ||
        above.name === "snow")
    ) {
      try {
        await digCancelable(bot, above, token);
      } catch (e) {
        if (token.cancelled) throw e;
        return false;
      }
    }

    if (TILLABLE.has(live.name) || live.name === "farmland") {
      try {
        await digCancelable(bot, live, token);
      } catch (e) {
        if (token.cancelled) throw e;
        return false;
      }
    }

    const hole = bot.blockAt(dest.position);
    const below = bot.blockAt(dest.position.offset(0, -1, 0));
    if (!below || !hole || (hole.name !== "air" && hole.name !== "cave_air")) return false;

    try {
      await boundedOp(bot.equip(bucket, "hand"), token, 5_000, "equip water_bucket");
      await boundedOp(bot.placeBlock(below, new Vec3(0, 1, 0)), token, 4_000, "place water source");
    } catch (e) {
      if (token.cancelled) throw e;
      return false;
    }
    await sleepCancellable(150, token);
    const placed = bot.blockAt(dest.position);
    return Boolean(placed && isWaterBlockName(placed.name));
  }

  // ---------------------------------------------------------------- runs

  /** çapalama koşusu: alandaki tüm uygun toprakları farmland yap */
  async runTill(opts: TillOpts, token: TaskToken, report: ProgressFn): Promise<string> {
    const bot = applyFarmMovement(this.instance);
    const c = areaCenter(this.instance, opts);
    const max = Math.max(1, Math.min(1024, opts.maxBlocks ?? (2 * c.r + 1) ** 2));
    const cells = scanArea(bot, c, (b, above) => TILLABLE.has(b.name) && (isAirLike(above) || above == null), max);
    if (!cells.length) {
      return `No tillable soil (dirt/grass/dirt_path) within r=${c.r} of ${c.x},${c.y},${c.z}.`;
    }

    let hydroNote = "";
    const anyHydrated = cells.some((cell) => isFarmlandHydrated(bot, cell.position));
    if (!anyHydrated && !isRaining(bot)) {
      const placed = await this.tryPlaceWaterSource(c, token).catch((e) => {
        if (token.cancelled) throw e;
        return false;
      });
      hydroNote = placed
        ? " Placed a water source in the plot."
        : " No water nearby — plant immediately or farmland dries.";
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
          await farmNear(
            this.instance,
            cell.position.x + 0.5,
            cell.position.y + 1,
            cell.position.z + 0.5,
            2.5,
            token
          );
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
    const msg = `Tilled ${tilled}/${cells.length} block(s) with ${hoeName}${failed ? ` · ${failed} failed/skipped` : ""}.${hydroNote}`;
    this.log().info("Till finished", msg);
    report({ done: cells.length, total: cells.length, label: `tilled ${tilled}` });
    return msg;
  }

  /** ekim koşusu */
  async runPlant(opts: PlantOpts, token: TaskToken, report: ProgressFn): Promise<string> {
    const bot = applyFarmMovement(this.instance);
    const c = areaCenter(this.instance, opts);
    const seed = seedForCrop(opts.crop ?? "wheat_seeds");
    const max = Math.max(1, Math.min(1024, opts.maxBlocks ?? (2 * c.r + 1) ** 2));
    const cells = scanArea(bot, c, (b, above) => isPlantableFarmland(b, above), max);
    if (!cells.length) return `No empty farmland within r=${c.r} — till first (till_soil).`;

    const have = await this.ensureSeeds(seed, token);
    if (have <= 0) {
      if (isCreativeMode(bot)) {
        await creativeEnsureItem(bot, seed, 16);
      }
    }
    if (bot.inventory.items().reduce((s, i) => s + (i.name === seed ? i.count : 0), 0) <= 0) {
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
          await farmNear(
            this.instance,
            cell.position.x + 0.5,
            cell.position.y + 1,
            cell.position.z + 0.5,
            2.5,
            token
          );
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
    const bot = applyFarmMovement(this.instance);
    const c = areaCenter(this.instance, opts);
    const replant = opts.replant !== false;
    const max = Math.max(1, Math.min(1024, opts.maxBlocks ?? (2 * c.r + 1) ** 2));
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
          await farmNear(
            this.instance,
            cell.position.x + 0.5,
            cell.position.y,
            cell.position.z + 0.5,
            2.5,
            token
          );
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
        let under = bot.blockAt(cell.position.offset(0, -1, 0));
        const seed = cropForSeed(cropName);
        if (under && TILLABLE.has(under.name)) {
          await this.ensureHoe(token, report);
          await this.tillCell(under, token);
          under = bot.blockAt(under.position);
        }
        if (under && under.name === "farmland" && seed) {
          await this.ensureSeeds(seed, token);
          const res = await this.plantCell(under, seed, token).catch((e) => {
            if (token.cancelled) throw e;
            return "failed" as const;
          });
          if (res === "planted") replanted++;
        }
      }
      // Survival: pick up drops. Creative breaking does not drop items.
      if (!isCreativeMode(bot) && harvested % 8 === 0) {
        try {
          await runSmartCollectDrops(this.instance, undefined, 6, token, () => {}, 4_000);
        } catch (e) {
          if (token.cancelled) throw e;
        }
      }
    }
    // Same-pass repair: re-hoe dirt we trampled while walking the plot.
    if (replant) {
      const trampled = scanArea(
        bot,
        c,
        (b, above) => TILLABLE.has(b.name) && (isAirLike(above) || above == null),
        32
      );
      for (const cell of trampled) {
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        applyFarmMovement(this.instance);
        const d = bot.entity.position.distanceTo(cell.position.offset(0.5, 1, 0.5));
        if (d > REACH) {
          try {
            await farmNear(
              this.instance,
              cell.position.x + 0.5,
              cell.position.y + 1,
              cell.position.z + 0.5,
              2.5,
              token
            );
          } catch (e) {
            if (token.cancelled) throw e;
            continue;
          }
        }
        await this.ensureHoe(token, report);
        await this.tillCell(cell, token);
      }
    }
    // final süpürme
    if (!isCreativeMode(bot)) {
      try {
        await runSmartCollectDrops(this.instance, undefined, Math.min(c.r + 4, 12), token, () => {}, 8_000);
      } catch (e) {
        if (token.cancelled) throw e;
      }
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
    const seed = seedForCrop(opts.crop ?? "wheat_seeds");
    const interval = Math.max(10, Math.min(3600, opts.intervalSec ?? 45)) * 1000;
    const maxCycles = Math.max(0, Math.floor(opts.maxCycles ?? 0));
    const doTill = opts.till !== false;
    const hasChest = opts.depositX != null && opts.depositY != null && opts.depositZ != null;
    const totals = new Map<string, number>();

    let cycle = 0;
    for (;;) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      applyFarmMovement(this.instance);
      const c = areaCenter(this.instance, opts);
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
          await farmNear(this.instance, c.x + 0.5, c.y, c.z + 0.5, 3, token).catch((e) => {
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

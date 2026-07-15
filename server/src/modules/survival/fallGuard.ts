import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { BotInstance } from "../../core/BotInstance";
import { isHostileMob } from "../combat/mobs";
import { v3 } from "../build/vec3util";

/** Düşüş kurtarma yöntemi (öncelik skoru yüksek = tercih) */
export type FallMethod =
  | "water"
  | "boat"
  | "hay"
  | "slime"
  | "cobweb"
  | "ladder"
  | "scaffolding"
  | "powder_snow"
  | "none";

export interface FallGuardState {
  active: boolean;
  falling: boolean;
  method: FallMethod | null;
  fallDistance: number;
  remainingBlocks: number;
  predictedDamage: number;
  lethal: boolean;
  lastAction: string;
  inventoryOptions: FallMethod[];
}

export interface FallGuardConfig {
  enabled: boolean;
  /** Bu HP hasarı ve üstünde müdahale (1 HP = yarım kalp) */
  minDamageHp: number;
  /** Hasar sonrası can bu altına düşecekse "ölümcül" say */
  lethalHealthMargin: number;
  /**
   * Yere bu kadar blok kala MLG başlat (taban).
   * Gerçek tetik: hız + ping ile dinamik hesaplanır; bu değer alt sınır / UI.
   */
  mlgTriggerBlocks: number;
  /** Sadece tehlikeli/lethal fallte müdahale */
  onlyWhenDangerous: boolean;
  /** MLG sonrası malzeme geri al (su neredeyse her zaman) */
  autoReclaim: boolean;
  /** Su/powder snow kovası — zor durum dışında kesin geri al */
  reclaimWater: boolean;
  /** Tekne kır / al */
  reclaimBoat: boolean;
  /** Hay/slime/cobweb/ladder/scaffolding kır-al */
  reclaimBlocks: boolean;
}

export const DEFAULT_FALL_GUARD: FallGuardConfig = {
  enabled: true,
  minDamageHp: 4,
  lethalHealthMargin: 2,
  // 4.5 blok raycast sınırına yakın erken tetik — asıl place daha alçakta
  mlgTriggerBlocks: 5.5,
  onlyWhenDangerous: true,
  autoReclaim: true,
  reclaimWater: true,
  reclaimBoat: true,
  reclaimBlocks: true
};

/** MLG sonrası geri alınacak place kaydı */
interface MlgRecoverJob {
  id: number;
  method: FallMethod;
  x: number;
  y: number;
  z: number;
  placedAt: number;
  /** son deneme zamanı */
  lastTryAt: number;
  tries: number;
  /** bu time kadar dene */
  deadline: number;
  /** su = yüksek öncelik */
  priority: number;
  /** isteğe bağlı blok adı (kırılacak) */
  blockName?: string;
  /** peş peşe unsafe tick — vakit kaybını kes */
  unsafeStreak?: number;
  /** MLG sonrası target dolu kova sayısı (geri alınca buna ulaş) */
  wantFilledCount?: number;
  filledName?: string;
  usedBuckets?: number;
}

/** Blok etkileşim menzili (su koyabilmek for katı bloğa bakış) */
const BLOCK_REACH = 4.45;
// caya-combat-mlg-stability-v2: MLG hazırlık kilidi + tahmini iniş doğrulaması.
const caya_combat_mlg_stability_v2_fall_guard = true;

const BOAT_NAMES = [
  "oak_boat",
  "spruce_boat",
  "birch_boat",
  "jungle_boat",
  "acacia_boat",
  "dark_oak_boat",
  "mangrove_boat",
  "cherry_boat",
  "bamboo_raft",
  "oak_chest_boat",
  "spruce_chest_boat",
  "birch_chest_boat",
  "jungle_chest_boat",
  "acacia_chest_boat",
  "dark_oak_chest_boat",
  "mangrove_chest_boat",
  "cherry_chest_boat",
  "bamboo_chest_raft"
];

/** Yumuşak iniş / hasarsız yüzeyler */
const SOFT_LANDING = new Set([
  "water",
  "bubble_column",
  "lava",
  "cobweb",
  "powder_snow",
  "hay_block",
  "slime_block",
  "honey_block",
  "scaffolding",
  "ladder",
  "vine",
  "twisting_vines",
  "weeping_vines",
  "twisting_vines_plant",
  "weeping_vines_plant",
  "sweet_berry_bush"
]);

/**
 * Su/tekne MLG for kötü yüzey — yaprak, çit, cam paneli, karpet vb.
 * Üzerine su koymak boşa gider veya hasarı kesmez.
 */
function isBadWaterSurfaceName(n0: string): boolean {
  const n = n0.replace(/^minecraft:/, "").toLowerCase();
  if (n.includes("leaves") || n.includes("leaf")) return true;
  if (n.includes("fence") || n.includes("fence_gate")) return true;
  if (n.endsWith("_wall") || n.includes("_wall_")) return true;
  if (n.includes("pane") || n.includes("bars") || n.includes("iron_bars")) return true;
  if (n.endsWith("_carpet") || n === "moss_carpet" || n === "snow" || n === "powder_snow") return true;
  if (n.includes("slab") || n.includes("stairs") || n.includes("trapdoor")) return true;
  if (n.includes("door") && !n.includes("trapdoor")) return true;
  if (n.includes("sign") || n.includes("banner") || n.includes("torch") || n.includes("lantern")) return true;
  if (n.includes("flower") || n.includes("tulip") || n.includes("orchid") || n.includes("lilac")) return true;
  // ot/bitki — grass_block DEĞİL (includes("grass") grass_block'u da bozardı)
  if (
    n === "grass" ||
    n === "short_grass" ||
    n === "tall_grass" ||
    n === "fern" ||
    n === "large_fern" ||
    n.includes("seagrass") ||
    n.includes("kelp") ||
    n === "dead_bush"
  ) {
    return true;
  }
  if (n.includes("sapling") || n.includes("mushroom") || n.includes("roots") || n.includes("fungus")) return true;
  if (n.includes("vine") || n === "lily_pad" || n === "scaffolding" || n === "ladder" || n === "cobweb") return true;
  if (n.includes("button") || n.includes("pressure_plate") || n.includes("rail") || n.includes("carpet")) return true;
  if (n.includes("candle") || n.includes("head") || n.includes("skull") || n.includes("pot")) return true;
  if (n.includes("chain") || n === "pointed_dripstone" || n.includes("amethyst_bud")) return true;
  if (n === "hopper" || n === "lectern" || n.includes("anvil") || n === "bell") return true;
  if (n.includes("chest") || n.includes("barrel") || n === "ender_chest") return true; // weird top
  return false;
}

/** Tam blok yüzey mi? (su koyulabilir) */
function isWaterPlaceableBlock(block: { name: string; boundingBox?: string } | null | undefined): boolean {
  if (!block) return false;
  const n = block.name.replace(/^minecraft:/, "");
  if (isAirName(n)) return false;
  if (n.includes("water") || n === "lava" || n === "bubble_column") return false;
  if (isBadWaterSurfaceName(n)) return false;
  // mineflayer: full cube genelde "block"
  const bb = block.boundingBox;
  if (bb && bb !== "block") return false;
  return true;
}

/** Işın/geçiş — düşüş hesabında yok say (yere basılmaz) */
function isFallThroughName(n0: string): boolean {
  const n = n0.replace(/^minecraft:/, "").toLowerCase();
  if (isAirName(n)) return true;
  if (n.includes("sign") || n === "torch" || n.includes("wall_torch") || n.includes("button")) return true;
  if (n.includes("pressure_plate") || n.includes("rail") || n.includes("tripwire") || n === "fire") return true;
  if (n.includes("banner") || n.includes("lever") || n.includes("redstone_wire") || n === "light") return true;
  return false;
}

/**
 * Yüksekten düşerken hasar almamak / ölmemek for MLG ve yumuşak iniş.
 * Pathfinder/görevlerden bağımsız, tick bazlı.
 */
export class FallGuardService {
  private bot: Bot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private preEquipBusy = false;
  private preEquippedMethod: FallMethod | null = null;
  private lastPreEquipAt = 0;
  private reclaimBusy = false;
  private lastMlgAt = 0;
  private lastEmitAt = 0;
  private lastWarnAt = 0;
  private fallPeakY: number | null = null;
  private recoverJobs: MlgRecoverJob[] = [];
  private recoverSeq = 1;
  private state: FallGuardState = idleState();

  constructor(private readonly instance: BotInstance) {}

  getState(): FallGuardState {
    const reclaim =
      this.recoverJobs.length > 0
        ? `reclaim kuyruk:${this.recoverJobs.map((j) => j.method).join(",")}`
        : this.state.lastAction;
    return {
      ...this.state,
      lastAction: reclaim || this.state.lastAction,
      inventoryOptions: [...this.state.inventoryOptions]
    };
  }

  private cfg(): FallGuardConfig {
    const s = this.instance.config.survival as { fallGuard?: Partial<FallGuardConfig> };
    return { ...DEFAULT_FALL_GUARD, ...(s.fallGuard ?? {}) };
  }

  private log() {
    return this.instance.getLogger();
  }

  attach(bot: Bot) {
    this.detach();
    this.bot = bot;
    this.timer = setInterval(() => void this.tick(), 40);
  }

  detach() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bot = null;
    this.busy = false;
    this.reclaimBusy = false;
    this.preEquipBusy = false;
    this.preEquippedMethod = null;
    this.lastPreEquipAt = 0;
    this.recoverJobs = [];
    this.fallPeakY = null;
    this.state = idleState();
  }

  /** MLG place kaydı — sonra geri alınacak */
  private enqueueRecover(
    method: FallMethod,
    pos: { x: number; y: number; z: number },
    opts?: {
      blockName?: string;
      ttlMs?: number;
      wantFilledCount?: number;
      filledName?: string;
      usedBuckets?: number;
    }
  ) {
    const cfg = this.cfg();
    if (!cfg.autoReclaim) return;
    if (method === "water" || method === "powder_snow") {
      if (!cfg.reclaimWater) return;
    } else if (method === "boat") {
      if (!cfg.reclaimBoat) return;
    } else if (!cfg.reclaimBlocks) return;

    // aynı method for tek iş (konum sonrakine güncellenir)
    this.recoverJobs = this.recoverJobs.filter((j) => j.method !== method);

    const now = Date.now();
    const isWater = method === "water" || method === "powder_snow";
    const job: MlgRecoverJob = {
      id: this.recoverSeq++,
      method,
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
      placedAt: now,
      lastTryAt: 0,
      tries: 0,
      deadline: now + (opts?.ttlMs ?? (isWater ? 22_000 : 12_000)),
      priority: isWater ? 100 : method === "boat" ? 70 : 50,
      blockName: opts?.blockName,
      wantFilledCount: opts?.wantFilledCount,
      filledName: opts?.filledName,
      usedBuckets: opts?.usedBuckets ?? 1
    };
    this.recoverJobs.push(job);
    this.recoverJobs.sort((a, b) => b.priority - a.priority || a.placedAt - b.placedAt);
    this.log().info(
      "MLG reclaim queued",
      `${method} @${job.x},${job.y},${job.z}${job.wantFilledCount != null ? ` · target dolu=${job.wantFilledCount}` : ""}`
    );
  }

  private emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmitAt < 200) return;
    this.lastEmitAt = now;
    this.instance.emit("fallGuard", { botId: this.instance.config.id, fallGuard: this.getState() });
  }

  private async tick() {
    const bot = this.bot;
    if (!bot || this.instance.status !== "online" || !bot.entity) return;
    const cfg = this.cfg();
    if (!cfg.enabled) {
      if (this.state.falling || this.state.active) {
        this.state = idleState();
        this.fallPeakY = null;
        this.emit(true);
      }
      return;
    }

    if (shouldIgnoreFall(bot)) {
      if (this.state.falling || this.fallPeakY != null) {
        this.fallPeakY = null;
        this.state = idleState();
        this.state.lastAction = "fall ignored (effect/mod)";
        this.emit(true);
      }
      return;
    }

    // --- MLG malzeme geri alma (iniş sonrası / safe an) ---
    if (this.recoverJobs.length && !this.busy && !this.reclaimBusy) {
      void this.processRecoverQueue(bot);
    }

    const vy0 = bot.entity.velocity?.y ?? 0;
    const grounded = isEffectivelyGrounded(bot);

    // Yere değiyor / suda / merdivende — MLG YOK (sadece reclaim)
    if (grounded) {
      if (this.state.falling || this.state.active || this.fallPeakY != null) {
        this.state = idleState();
        this.state.lastAction =
          this.recoverJobs.length > 0 ? `landing done · reclaim pending (${this.recoverJobs.length})` : "landing done";
        this.fallPeakY = null;
        this.emit(true);
      }
      return;
    }

    const vy = vy0;
    const metaFall = Number((bot.entity as { fallDistance?: number }).fallDistance ?? 0);
    const feetY = bot.entity.position.y;
    // düşüş: net aşağı hız veya ciddi fallDistance (küçük zıplama ≠ MLG)
    const falling = vy < -0.28 || metaFall > 2.5 || (this.fallPeakY != null && feetY < this.fallPeakY - 1.2 && vy < -0.15);
    if (!falling) {
      if (this.state.falling) {
        this.state.falling = false;
        this.fallPeakY = null;
        this.emit(true);
      }
      return;
    }

    if (this.fallPeakY == null || feetY > this.fallPeakY) {
      this.fallPeakY = feetY;
    }

    const groundInfo = findLandingBelow(bot);
    if (groundInfo?.soft) {
      const remSoft = Math.max(0, feetY - groundInfo.standY);
      if (remSoft < 12) {
        this.state = {
          active: false,
          falling: true,
          method: null,
          fallDistance: round1(Math.max(metaFall, (this.fallPeakY ?? feetY) - groundInfo.standY)),
          remainingBlocks: round1(remSoft),
          predictedDamage: 0,
          lethal: false,
          lastAction: `soft landing: ${groundInfo.name}`,
          inventoryOptions: availableMethods(bot, this.instance.config.inventory.bannedItems)
        };
        this.emit();
        return;
      }
    }

    const remaining = groundInfo != null ? Math.max(0, feetY - groundInfo.standY) : estimateRemainingBlind(bot);

    // --- zaten yere yapışık / soft landing: su dökme ---
    // remaining çok küçük + yavaş = ayak değiyor (onGround bayrağı gecikebilir)
    if (remaining <= 0.45) {
      this.state.lastAction = "yerde (remaining≤0.45) — MLG yok";
      this.fallPeakY = null;
      this.emit();
      return;
    }
    if (remaining <= 1.15 && Math.abs(vy) < 0.5) {
      this.state.lastAction = "soft landing (slow+near) — no MLG";
      this.emit();
      return;
    }
    // kısa düşüş (2-3 blok zıplama / basamak): hasar yok denecek kadar
    if (metaFall < 3.2 && remaining < 2.8 && Math.abs(vy) < 0.95) {
      this.state.lastAction = "short fall — no MLG";
      this.emit();
      return;
    }

    const fromPeak =
      groundInfo != null && this.fallPeakY != null ? Math.max(0, this.fallPeakY - groundInfo.standY) : remaining;
    // en iyi düşüş distancesi: meta (gerçek) öncelikli; peak abartmasın
    const bestFall = Math.max(metaFall, Math.min(fromPeak, metaFall > 1 ? metaFall + Math.max(0, remaining - 0.5) : fromPeak));

    const { feather, protection } = armorFallEnchants(bot);
    const resistance = resistanceAmplifier(bot);
    let landingMul = 1;
    if (groundInfo?.soft) {
      if (groundInfo.name === "hay_block") landingMul = 0.2;
      else if (groundInfo.name === "slime_block" || groundInfo.name === "honey_block") landingMul = 0;
      else if (groundInfo.name === "cobweb" || groundInfo.name.includes("water")) landingMul = 0;
    }
    const predictedDamage = fallDamageHp(bestFall, feather, protection, resistance, landingMul);
    const health = bot.health ?? 20;
    const lethal = predictedDamage >= health - cfg.lethalHealthMargin;
    const dangerous = predictedDamage >= cfg.minDamageHp || lethal;

    const options = availableMethods(bot, this.instance.config.inventory.bannedItems);
    this.state = {
      active: this.busy,
      falling: true,
      method: this.state.method,
      fallDistance: round1(bestFall),
      remainingBlocks: round1(remaining),
      predictedDamage: round1(predictedDamage),
      lethal,
      lastAction: this.state.lastAction,
      inventoryOptions: options
    };

    if (cfg.onlyWhenDangerous && !dangerous) {
      this.emit();
      return;
    }
    if (!dangerous && bestFall < 4) {
      this.emit();
      return;
    }
    // hasar 0 tahmin — dökme
    if (predictedDamage < 1 && !lethal) {
      this.state.lastAction = "dmg≈0 — MLG yok";
      this.emit();
      return;
    }

    if (this.busy) {
      this.emit();
      return;
    }
    // başarılı MLG sonrası kısa bastırma (çift döküm / yerdeyken tekrar)
    if (Date.now() - this.lastMlgAt < 450) return;

    const method = pickBestMethod(options, remaining, lethal, predictedDamage, Math.abs(vy));
    if (method === "none") {
      if (lethal) void this.tryEquipTotem(bot);
      this.state.lastAction = lethal ? "no recovery — totem/lethal!" : "no recovery material";
      this.emit();
      if (lethal && Date.now() - this.lastWarnAt > 3000) {
        this.lastWarnAt = Date.now();
        this.log().warn("Lethal fall — no MLG material", `~${predictedDamage} HP · ${bestFall.toFixed(1)} blok`);
      }
      return;
    }

    // su for kötü yüzey (yaprak/ot vb.) → tekne/blok yastığa kay
    type PlaceMethod = Exclude<FallMethod, "none">;
    let chosen: PlaceMethod = method as PlaceMethod;
    if ((chosen === "water" || chosen === "powder_snow") && !hasWaterPlaceableNearby(bot, remaining + 1)) {
      const altOrder: PlaceMethod[] = ["boat", "hay", "slime", "cobweb", "scaffolding", "ladder"];
      const alt = altOrder.find((m) => options.includes(m));
      if (alt) {
        chosen = alt;
        this.state.lastAction = `bad surface (leaves/grass?) → ${alt}`;
      }
    }

    // --- dinamik tetik penceresi ---
    const windows = mlgWindows(chosen, Math.abs(vy), cfg.mlgTriggerBlocks, getBotPingMs(bot));
    // Bakış ve ekipman hazırlığı preEquip kilidi altında tek sıra halinde yürür.

    // prep: hâlâ yüksekte — kova/blok ele
    if (remaining > windows.prepareFrom) {
      if (!this.busy) void this.preEquip(bot, chosen);
      this.state.method = chosen;
      this.state.lastAction = `prep: ${chosen} (${remaining.toFixed(1)}m · v=${Math.abs(vy).toFixed(2)})`;
      this.emit();
      return;
    }

    // place penceresi: çok yüksekte raycast vurmaz; çok alçakta geç kalınır
    if (remaining > windows.placeMax) {
      if (!this.busy) void this.preEquip(bot, chosen);
      this.state.method = chosen;
      this.state.lastAction = `wait: ${chosen} @${windows.placeMax.toFixed(1)}m (now ${remaining.toFixed(1)})`;
      this.emit();
      return;
    }
    if (remaining < windows.placeMin && chosen !== "ladder" && chosen !== "scaffolding") {
      // neredeyse yere bastı — son şans yine de dene
      if (remaining < 0.25) {
        this.emit();
        return;
      }
    }

    this.busy = true;
    this.state.active = true;
    this.state.method = chosen;
    this.state.lastAction = `MLG: ${chosen}`;
    this.emit(true);
    this.log().info(
      `Fall recovery: ${chosen}`,
      `remaining ${remaining.toFixed(1)} · dmg≈${predictedDamage} HP · fall≈${bestFall.toFixed(1)} · vY=${vy.toFixed(2)} · window ${windows.placeMin.toFixed(1)}–${windows.placeMax.toFixed(1)}${lethal ? " LETHAL" : ""}`
    );

    try {
      try {
        (bot as { pathfinder?: { setGoal: (g: null) => void } }).pathfinder?.setGoal(null);
      } catch {
        /* */
      }
      // tüm hareketi kes (parkur/merdiven jump+forward MLG bakışını bozmasın)
      try {
        for (const k of ["forward", "back", "left", "right", "sprint", "jump"] as const) {
          bot.setControlState(k, false);
        }
      } catch {
        /* */
      }

      // son kontrol: yere değdiyse dökme
      if (isEffectivelyGrounded(bot)) {
        this.state.lastAction = "MLG cancelled — touched ground";
        this.fallPeakY = null;
        this.log().info("MLG cancelled", "touched ground / safe");
        return;
      }
      const remNow = (() => {
        const g = findLandingBelow(bot);
        if (!g || !bot.entity) return remaining;
        return Math.max(0, bot.entity.position.y - g.standY);
      })();
      if (remNow <= 0.4) {
        this.state.lastAction = "MLG cancelled — remaining too low";
        this.log().info("MLG cancelled", `remaining ${remNow.toFixed(2)}`);
        return;
      }

      const prepDeadline = Date.now() + 140;
      while (this.preEquipBusy && Date.now() < prepDeadline) await sleep(5);
      await snapLookDown(bot);
      const ok = await this.executeMethod(bot, chosen, remNow);
      if (ok) {
        this.lastMlgAt = Date.now();
        this.state.lastAction = `applied: ${chosen}`;
        this.log().info(`MLG success: ${chosen}`, `remaining≈${remNow.toFixed(1)}`);
        this.scheduleReclaimAfterLand(chosen);
      } else {
        this.lastMlgAt = 0;
        this.state.lastAction = `failed: ${chosen} — yeniden denenecek`;
        this.log().warn("Fall recovery did not place", `${chosen} · remaining ${remNow.toFixed(1)}`);
      }
    } catch (e) {
      this.lastMlgAt = 0;
      this.state.lastAction = `hata: ${e instanceof Error ? e.message : String(e)}`;
      this.log().warn("Fall recovery failed", e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
      this.state.active = false;
      this.emit(true);
    }
  }

  private async preEquip(bot: Bot, method: FallMethod) {
    if (this.preEquipBusy || this.busy) return;
    const item = findItemForMethod(bot, method, this.instance.config.inventory.bannedItems);
    if (!item) return;

    const now = Date.now();
    if (
      this.preEquippedMethod === method &&
      bot.heldItem?.name === item.name &&
      now - this.lastPreEquipAt < 250
    ) {
      return;
    }

    this.preEquipBusy = true;
    try {
      // Önce eşya; sonra tek bir bakış. Eski kod aynı 40 ms döngüsünde üst üste
      // equip/look promise'leri başlatıp place sırasını bozabiliyordu.
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      if (method === "water" || method === "powder_snow" || method === "boat") {
        await snapLookDown(bot);
      }
      this.preEquippedMethod = method;
      this.lastPreEquipAt = Date.now();
    } catch {
      this.preEquippedMethod = null;
    } finally {
      this.preEquipBusy = false;
    }
  }

private async tryEquipTotem(bot: Bot) {
    const banned = this.instance.config.inventory.bannedItems;
    if (banned.includes("totem_of_undying")) return;
    const totem = bot.inventory.items().find((i) => i.name === "totem_of_undying");
    if (!totem) return;
    try {
      await bot.equip(totem, "off-hand");
      this.state.lastAction = "totem sol el";
      this.log().info("Totem of Undying held offhand (lethal fall)");
      this.emit(true);
    } catch {
      try {
        await bot.equip(totem, "hand");
        this.state.lastAction = "totem main el";
      } catch {
        /* */
      }
    }
  }

  /** inişten sonra reclaim tetiklensin diye (su öncelikli) */
  private scheduleReclaimAfterLand(method: FallMethod) {
    // place* metodları zaten enqueueRecover çağırır; burada sadece hatırlatma log
    if (method === "water" || method === "powder_snow") {
      this.state.lastAction = `applied: ${method} · water will be reclaimed`;
    } else {
      this.state.lastAction = `applied: ${method} · materials will be reclaimed`;
    }
  }

  /** @returns true if placent likely succeeded */
  private async executeMethod(bot: Bot, method: FallMethod, remaining: number): Promise<boolean> {
    const banned = this.instance.config.inventory.bannedItems;
    const item = findItemForMethod(bot, method, banned);
    if (!item) throw new Error(`${method} item missing`);

    if (method === "water" || method === "powder_snow") {
      return this.placeBucketMlg(bot, item, method);
    }

    if (method === "boat") {
      return this.placeBoatMlg(bot, item);
    }

    await bot.equip(item, "hand");
    await sleep(20);
    // yere yastık: iniş yüzeyinin hemen üstü / 1 blok alt
    const land = findLandingBelow(bot);
    const feet = bot.entity.position;
    const tx = Math.floor(feet.x);
    const tz = Math.floor(feet.z);
    const ty = land
      ? Math.floor(land.standY)
      : Math.floor(feet.y - Math.min(2, Math.max(1, Math.ceil(remaining * 0.4))));
    const placed = await this.tryPlaceAt(bot, tx, ty, tz, method);
    if (placed) {
      const blockName =
        method === "hay"
          ? "hay_block"
          : method === "slime"
            ? "slime_block"
            : method === "cobweb"
              ? "cobweb"
              : method === "ladder"
                ? "ladder"
                : method === "scaffolding"
                  ? "scaffolding"
                  : undefined;
      this.enqueueRecover(method, { x: tx, y: ty, z: tz }, { blockName });
    }
    return placed;
  }

  /**
   * Su / powder snow kovası MLG.
   * Kritik: suyu havaya koyamazsın — raycast katı bloğa değmeli (reach ~4.5).
   * Çok yüksekte activateItem sessizce failed olur.
   */
  private async placeBucketMlg(bot: Bot, item: Item, method: FallMethod): Promise<boolean> {
    const filledName = method === "powder_snow" ? "powder_snow_bucket" : "water_bucket";
    const filledBefore = countItemName(bot, filledName);
    const emptyBefore = countItemName(bot, "bucket");

    const inventorySaysPlaced = () => {
      const filledAfter = countItemName(bot, filledName);
      const emptyAfter = countItemName(bot, "bucket");
      return filledAfter < filledBefore || emptyAfter > emptyBefore;
    };

    const markSuccess = (x: number, y: number, z: number, why: string) => {
      const filledAfter = countItemName(bot, filledName);
      const emptyAfter = countItemName(bot, "bucket");
      const used = Math.max(1, filledBefore - filledAfter, emptyAfter > emptyBefore ? 1 : 0);
      this.enqueueRecover(method, { x, y, z }, {
        wantFilledCount: filledAfter + used,
        filledName,
        usedBuckets: used
      });
      this.log().info(
        "MLG water placed (" + why + ")",
        filledName + " " + filledBefore + "→" + filledAfter + " · empty " + emptyBefore + "→" + emptyAfter
      );
      return true;
    };

    try {
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
    } catch {
      return false;
    }

    const deadline = Date.now() + 850;
    let lastTarget: { x: number; y: number; z: number } | null = null;

    for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt++) {
      if (!bot.entity || this.instance.status !== "online") return false;

      if (inventorySaysPlaced()) {
        const p = bot.entity.position;
        const t = lastTarget ?? findBestWaterPlaceTarget(bot, 4);
        return markSuccess(
          t?.x ?? Math.floor(p.x),
          t ? t.y + 1 : Math.floor(p.y),
          t?.z ?? Math.floor(p.z),
          "inventory"
        );
      }

      if (isInLiquid(bot) || (method === "powder_snow" && hasPowderSnowNear(bot))) {
        return false;
      }
      if (isEffectivelyGrounded(bot)) return false;

      const land = findLandingBelow(bot);
      const rem = land ? bot.entity.position.y - land.standY : estimateRemainingBlind(bot);
      if (rem > BLOCK_REACH + 0.2) {
        await snapLookDown(bot);
        await sleep(12);
        continue;
      }

      const target = findBestWaterPlaceTarget(bot, rem);
      if (!target) {
        this.state.lastAction = "MLG: no solid block under predicted landing";
        await snapLookDown(bot);
        await sleep(12);
        continue;
      }
      lastTarget = target;

      const solid = bot.blockAt(v3(target.x, target.y, target.z));
      const above = bot.blockAt(v3(target.x, target.y + 1, target.z));
      if (above && (above.name.includes("water") || above.name === "powder_snow")) {
        // Önceden var olan suyu kendimiz placemiş gibi reclaim kuyruğuna ekleme.
        this.state.lastAction = "MLG: landing surface already soft";
        return true;
      }
      if (!solid || !isWaterPlaceableBlock(solid)) {
        await sleep(10);
        continue;
      }

      const held = bot.heldItem;
      if (held?.name !== item.name) {
        const again = bot.inventory.items().find((candidate) => candidate.name === item.name);
        if (!again) {
          if (inventorySaysPlaced()) return markSuccess(target.x, target.y + 1, target.z, "bucket-used");
          return false;
        }
        try {
          await bot.equip(again, "hand");
        } catch {
          return false;
        }
      }

      // Hedef her denemede güncellenir; karmaşık zeminde komşu yüksek bloğa değil,
      // tahmini ayak izinin altındaki tam yüzeye nişan alınır.
      await snapLookAt(bot, target.x + 0.5, target.y + 0.995, target.z + 0.5);

      try {
        bot.activateItem(false);
      } catch {
        try {
          await bot.activateItem();
        } catch {
          /* paket yedeği aşağıda */
        }
      }

      await sleep(18);
      if (!inventorySaysPlaced()) {
        try {
          await bot.activateBlock(solid);
        } catch {
          /* bazı sürümlerde activateItem yeterli */
        }
      }
      if (!inventorySaysPlaced() && attempt % 2 === 1) tryUseItemPacket(bot);
      await sleep(24);

      try {
        bot.deactivateItem();
      } catch {
        /* */
      }

      if (inventorySaysPlaced()) {
        return markSuccess(target.x, target.y + 1, target.z, "inventory-sonra");
      }
      if (
        isInLiquid(bot) ||
        hasWaterNear(bot, target.x, target.y + 1, target.z) ||
        (method === "powder_snow" && hasPowderSnowNear(bot))
      ) {
        return markSuccess(target.x, target.y + 1, target.z, "world");
      }

      await sleep(10);
    }

    if (inventorySaysPlaced() && bot.entity) {
      const p = bot.entity.position;
      const t = lastTarget;
      return markSuccess(t?.x ?? Math.floor(p.x), t ? t.y + 1 : Math.floor(p.y), t?.z ?? Math.floor(p.z), "final");
    }

    this.log().warn(
      "MLG water not placed",
      filledName + " " + filledBefore + "→" + countItemName(bot, filledName) + " · empty " + emptyBefore + "→" + countItemName(bot, "bucket")
    );
    return false;
  }

private async placeBoatMlg(bot: Bot, item: Item): Promise<boolean> {
    try {
      await bot.equip(item, "hand");
    } catch {
      return false;
    }
    for (let i = 0; i < 8; i++) {
      if (!bot.entity || bot.entity.onGround) break;
      const land = findLandingBelow(bot);
      const rem = land ? bot.entity.position.y - land.standY : 99;
      if (rem > BLOCK_REACH) {
        await lookDown(bot);
        await sleep(40);
        continue;
      }
      if (land) {
        const bx = Math.floor(bot.entity.position.x);
        const bz = Math.floor(bot.entity.position.z);
        const solid = bot.blockAt(v3(bx, Math.floor(land.standY) - 1, bz));
        if (solid) {
          try {
            await bot.lookAt(solid.position.offset(0.5, 1.05, 0.5), true);
          } catch {
            await lookDown(bot);
          }
        } else await lookDown(bot);
      } else await lookDown(bot);

      try {
        bot.activateItem(false);
      } catch {
        try {
          await bot.activateItem();
        } catch {
          /* */
        }
      }
      await sleep(50);
      try {
        bot.deactivateItem();
      } catch {
        /* */
      }
      // tekne entity var mı?
      if (nearbyBoat(bot)) {
        const p = bot.entity.position;
        this.enqueueRecover("boat", { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
        return true;
      }
      await sleep(40);
    }
    if (nearbyBoat(bot)) {
      const p = bot.entity.position;
      this.enqueueRecover("boat", { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
      return true;
    }
    return false;
  }

  private async tryPlaceAt(bot: Bot, x: number, y: number, z: number, method: FallMethod): Promise<boolean> {
    const existing = bot.blockAt(v3(x, y, z));
    if (existing && !isAirName(existing.name)) {
      if (method === "ladder") {
        await this.placeLadderOnNearestWall(bot);
        return true;
      }
      // zaten dolu — soft mu?
      if (SOFT_LANDING.has(existing.name.replace(/^minecraft:/, ""))) return true;
    }

    const faces: [number, number, number][] = [
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0, 1, 0]
    ];
    for (const [fx, fy, fz] of faces) {
      const refPos = v3(x + fx, y + fy, z + fz);
      const ref = bot.blockAt(refPos);
      if (!ref || isAirName(ref.name) || ref.name === "water" || ref.name === "lava") continue;
      try {
        await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(ref, v3(-fx, -fy, -fz));
        return true;
      } catch {
        continue;
      }
    }
    if (method === "ladder") {
      await this.placeLadderOnNearestWall(bot);
      return true;
    }
    return false;
  }

  private async placeLadderOnNearestWall(bot: Bot) {
    const p = bot.entity.position;
    const base = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const dirs: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1]
    ];
    for (const [dx, , dz] of dirs) {
      const wall = bot.blockAt(v3(base.x + dx, base.y, base.z + dz));
      if (!wall || isAirName(wall.name)) continue;
      try {
        await bot.lookAt(wall.position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(wall, v3(-dx, 0, -dz));
        bot.setControlState("forward", true);
        await sleep(100);
        bot.setControlState("forward", false);
        return;
      } catch {
        continue;
      }
    }
  }

  // ---- MLG malzeme geri alma ------------------------------------------------

  /**
   * Güvenli mi? Zor durumda (can kritik, on fire, near enemy combatü, düşüşte)
   * su bile gecikir; diğer malzemeler daha sıkı.
   */
  private isSafeToReclaim(bot: Bot, job: MlgRecoverJob): { ok: boolean; reason?: string } {
    if (!bot.entity) return { ok: false, reason: "entity yok" };
    if (this.busy) return { ok: false, reason: "MLG aktif" };
    if (this.instance.status !== "online") return { ok: false, reason: "offline" };

    const hp = bot.health ?? 20;
    const isWater = job.method === "water" || job.method === "powder_snow";

    // düşerken geri alma (su hariç — suda iniş sonrası alınır)
    const vy = bot.entity.velocity?.y ?? 0;
    const metaFall = Number((bot.entity as { fallDistance?: number }).fallDistance ?? 0);
    if (!bot.entity.onGround && !isInLiquid(bot) && (vy < -0.4 || metaFall > 2)) {
      return { ok: false, reason: "still falling" };
    }

    // ateş / lav — önce kaç
    try {
      if ((bot as { onFire?: boolean }).onFire) return { ok: false, reason: "on fire" };
    } catch {
      /* */
    }
    if (isInLavaNear(bot)) return { ok: false, reason: "lav" };

    // can çok düşük — su yine de al (kova hayati); blok/tekne ertele
    if (hp <= 4 && !isWater) return { ok: false, reason: "can kritik" };

    // combat: yakın hostile ve can düşükse ertele (su: sadece mob ≤2.5m ve can≤6)
    const nearThreat = nearestHostileDist(bot);
    if (nearThreat != null) {
      if (isWater) {
        if (nearThreat < 2.2 && hp <= 6) return { ok: false, reason: "near enemy+low health" };
      } else if (nearThreat < 4.5) {
        return { ok: false, reason: "near enemy" };
      }
    }

    // combat mode saldırı/savunma + çok yakın tehdit
    try {
      const mode = this.instance.combat?.getRuntime?.()?.mode;
      if (mode === "fleeing") return { ok: false, reason: "fleeing" };
      if ((mode === "attacking" || mode === "defending") && nearThreat != null && nearThreat < 3 && !isWater) {
        return { ok: false, reason: "combat" };
      }
    } catch {
      /* */
    }

    return { ok: true };
  }

  private async processRecoverQueue(bot: Bot) {
    if (this.reclaimBusy || !this.recoverJobs.length) return;
    const now = Date.now();
    // süresi dolanları at
    this.recoverJobs = this.recoverJobs.filter((j) => j.deadline > now);
    if (!this.recoverJobs.length) return;

    // su önce
    this.recoverJobs.sort((a, b) => b.priority - a.priority || a.placedAt - b.placedAt);
    const job = this.recoverJobs[0]!;
    if (now - job.lastTryAt < (job.method === "water" ? 220 : 450)) return;

    const safety = this.isSafeToReclaim(bot, job);
    if (!safety.ok) {
      // unsafe: vakit kaybetme — sayaç artır, kısa süre sonra vazgeç
      job.unsafeStreak = (job.unsafeStreak ?? 0) + 1;
      job.lastTryAt = now;
      const isWater = job.method === "water" || job.method === "powder_snow";
      // tehdit/fleeing/yanma: su for de çabuk drop (hayati değil, hayatta kal)
      const hardUnsafe =
        safety.reason === "fleeing" ||
        safety.reason === "on fire" ||
        safety.reason === "lav" ||
        safety.reason === "near enemy+low health" ||
        safety.reason === "still falling";
      if (hardUnsafe && job.unsafeStreak >= (isWater ? 3 : 1)) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `reclaim cancel (unsafe: ${safety.reason})`;
        this.log().info("MLG reclaim ertelendi/cancelled", `${job.method} · ${safety.reason}`);
        this.emit(true);
        return;
      }
      if (!isWater && job.unsafeStreak >= 2) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `reclaim cancelled: ${job.method} (${safety.reason})`;
        return;
      }
      // su: biraz bekle (iniş oturması) ama sonsuza kadar uğraşma
      if (isWater && job.unsafeStreak >= 12) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `reclaim aborted (persistently unsafe)`;
        return;
      }
      return;
    }
    job.unsafeStreak = 0;

    this.reclaimBusy = true;
    job.lastTryAt = now;
    job.tries += 1;
    try {
      let ok = false;
      if (job.method === "water" || job.method === "powder_snow") {
        ok = await this.reclaimWater(bot, job);
      } else if (job.method === "boat") {
        ok = await this.reclaimBoat(bot, job);
      } else {
        ok = await this.reclaimBlock(bot, job);
      }

      if (ok) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `geri withdrawn: ${job.method}`;
        this.log().info(`MLG malzeme geri withdrawn: ${job.method}`, `@${job.x},${job.y},${job.z}`);
        this.emit(true);
      } else if (job.tries >= (job.method === "water" ? 16 : 10) || now > job.deadline) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `reclaim aborted: ${job.method}`;
        this.log().warn(`MLG reclaim failed: ${job.method}`, `${job.tries} deneme`);
        this.emit(true);
      } else {
        this.state.lastAction = `reclaim deniyor: ${job.method} (#${job.tries})`;
      }
    } catch (e) {
      this.log().debug("MLG reclaim hata", e instanceof Error ? e.message : String(e));
    } finally {
      this.reclaimBusy = false;
    }
  }

  /**
   * Su / powder snow kovaya geri al.
   * Başarı = inventory dolu kova sayısı targete ulaştı (çoklu kova safe).
   * Dünya taraması: ayak + job + geniş — ot/yaprak üstüne akmış suyu bulur.
   */
  private async reclaimWater(bot: Bot, job: MlgRecoverJob): Promise<boolean> {
    const filledName =
      job.filledName ?? (job.method === "powder_snow" ? "powder_snow_bucket" : "water_bucket");
    const filledNow = countItemName(bot, filledName);
    const want = job.wantFilledCount ?? filledNow + (job.usedBuckets ?? 1);

    // target dolu kova sayısına ulaşıldı
    if (filledNow >= want) {
      this.log().info("MLG su reclaim OK (inventory)", `${filledName}=${filledNow} ≥ ${want}`);
      return true;
    }

    const emptyItem =
      bot.inventory.items().find((i) => i.name === "bucket") ??
      (bot.heldItem?.name === "bucket" ? bot.heldItem : null);

    if (!emptyItem) {
      // boş kova yok ama targete ulaşmadık — belki başka yoldan doldu
      return filledNow >= want || job.tries > 5;
    }

    const p = bot.entity.position;
    const feetX = Math.floor(p.x);
    const feetY = Math.floor(p.y);
    const feetZ = Math.floor(p.z);

    const raw = [
      findNearestWaterSource(bot, feetX, feetY, feetZ, 6),
      findNearestWaterSource(bot, job.x, job.y, job.z, 6),
      findNearestWaterSource(bot, feetX, feetY, feetZ, 10)
    ].filter(Boolean) as Array<{ x: number; y: number; z: number; name: string; dist: number }>;

    const seen = new Set<string>();
    const ordered: typeof raw = [];
    for (const c of raw.sort((a, b) => a.dist - b.dist)) {
      const k = `${c.x},${c.y},${c.z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      ordered.push(c);
    }

    if (!ordered.length) {
      // su yok — targete ulaştıysak OK, değilse birkaç deneme sonra drop
      return filledNow >= want || job.tries > 8;
    }

    const before = filledNow;
    for (const c of ordered.slice(0, 4)) {
      if (c.dist > 5.0) continue;
      await this.scoopWaterBlock(
        bot,
        { position: { x: c.x, y: c.y, z: c.z }, name: c.name },
        emptyItem as Item,
        job.method
      );
      const after = countItemName(bot, filledName);
      if (after > before || after >= want) {
        job.x = c.x;
        job.y = c.y;
        job.z = c.z;
        this.log().info("MLG su reclaim OK", `${filledName} ${before}→${after} (target ${want})`);
        return after >= want || after > before;
      }
      const s = this.isSafeToReclaim(bot, job);
      if (!s.ok && s.reason !== "still falling") return false;
    }
    return countItemName(bot, filledName) >= want;
  }

  private async scoopWaterBlock(
    bot: Bot,
    block: { position: { x: number; y: number; z: number }; name: string },
    empty: Item | null,
    method: FallMethod
  ): Promise<boolean> {
    const bucket =
      empty ??
      bot.inventory.items().find((i) => i.name === "bucket") ??
      null;
    if (!bucket) return false;

    const filledName = method === "powder_snow" ? "powder_snow_bucket" : "water_bucket";
    const before = countItemName(bot, filledName);
    const emptyBefore = countItemName(bot, "bucket");

    try {
      if (bot.heldItem?.name !== "bucket") await bot.equip(bucket, "hand");
    } catch {
      return false;
    }

    const bx = block.position.x;
    const by = block.position.y;
    const bz = block.position.z;
    try {
      await bot.lookAt(v3(bx + 0.5, by + 0.4, bz + 0.5), true);
    } catch {
      try {
        await bot.lookAt(v3(bx + 0.5, by + 0.9, bz + 0.5), true);
      } catch {
        /* */
      }
    }
    await sleep(40);

    try {
      bot.activateItem(false);
    } catch {
      try {
        await bot.activateItem();
      } catch {
        /* */
      }
    }
    await sleep(80);
    try {
      bot.deactivateItem();
    } catch {
      /* */
    }

    try {
      const b = bot.blockAt(v3(Math.floor(bx), Math.floor(by), Math.floor(bz)));
      if (b) await bot.activateBlock(b);
    } catch {
      /* */
    }
    tryUseItemPacket(bot);
    await sleep(70);

    const after = countItemName(bot, filledName);
    const emptyAfter = countItemName(bot, "bucket");
    // dolu arttı veya boş azaldı
    if (after > before || emptyAfter < emptyBefore) return true;
    if (bot.heldItem?.name === filledName) return true;
    return false;
  }

  private async reclaimBoat(bot: Bot, job: MlgRecoverJob): Promise<boolean> {
    // yakındaki tekne entity
    let boat: { id: number; position: { x: number; y: number; z: number } } | null = null;
    let bestD = 4.5;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      const n = String(e.name ?? e.displayName ?? "").toLowerCase();
      if (!n.includes("boat") && !n.includes("raft")) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d < bestD) {
        bestD = d;
        boat = e as { id: number; position: { x: number; y: number; z: number } };
      }
    }
    // entries noktasına yakın
    if (!boat) {
      for (const id in bot.entities) {
        const e = bot.entities[id];
        if (!e) continue;
        const n = String(e.name ?? "").toLowerCase();
        if (!n.includes("boat") && !n.includes("raft")) continue;
        const d = Math.hypot(e.position.x - job.x, e.position.y - job.y, e.position.z - job.z);
        if (d < 5) {
          boat = e as { id: number; position: { x: number; y: number; z: number } };
          break;
        }
      }
    }
    if (!boat) {
      // tekne yok — belki kırıldı / despawn; inventoryde varsa OK
      return (
        job.tries > 4 ||
        bot.inventory.items().some((i) => i.name.endsWith("_boat") || i.name.endsWith("_raft") || BOAT_NAMES.includes(i.name))
      );
    }

    try {
      await bot.lookAt(v3(boat.position.x, boat.position.y + 0.3, boat.position.z), true);
      // attack = tekne kır (survival)
      const ent = bot.entities[boat.id];
      if (ent) {
        bot.attack(ent);
        await sleep(200);
        bot.attack(ent);
        await sleep(250);
      }
    } catch {
      /* */
    }

    // yerdeki item'a doğru biraz bekle (otomatik pickup)
    await sleep(300);
    return (
      !bot.entities[boat.id] ||
      bot.inventory.items().some((i) => i.name.endsWith("_boat") || i.name.endsWith("_raft") || BOAT_NAMES.includes(i.name))
    );
  }

  private async reclaimBlock(bot: Bot, job: MlgRecoverJob): Promise<boolean> {
    const names = job.blockName
      ? [job.blockName]
      : job.method === "hay"
        ? ["hay_block"]
        : job.method === "slime"
          ? ["slime_block"]
          : job.method === "cobweb"
            ? ["cobweb"]
            : job.method === "ladder"
              ? ["ladder", "vine"]
              : job.method === "scaffolding"
                ? ["scaffolding"]
                : [];

    // blok ara
    let target: ReturnType<Bot["blockAt"]> = null;
    for (const dy of [0, 1, -1, 2, -2]) {
      for (const dx of [0, 1, -1]) {
        for (const dz of [0, 1, -1]) {
          const b = bot.blockAt(v3(job.x + dx, job.y + dy, job.z + dz));
          if (!b) continue;
          const n = b.name.replace(/^minecraft:/, "");
          if (names.some((w) => n === w || n.includes(w))) {
            target = b;
            break;
          }
        }
        if (target) break;
      }
      if (target) break;
    }
    // ayak altında
    if (!target) {
      const p = bot.entity.position;
      for (const dy of [0, -1, 1]) {
        const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y) + dy, Math.floor(p.z)));
        if (!b) continue;
        const n = b.name.replace(/^minecraft:/, "");
        if (names.some((w) => n === w || n.includes(w))) {
          target = b;
          break;
        }
      }
    }

    if (!target) {
      // blok yok — withdrawn veya yok oldu
      return job.tries > 3;
    }

    try {
      await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true);
      // soft break
      if (bot.canDigBlock && !bot.canDigBlock(target)) {
        return false;
      }
      await bot.dig(target, true);
      await sleep(150);
      return true;
    } catch {
      return false;
    }
  }
}

function idleState(): FallGuardState {
  return {
    active: false,
    falling: false,
    method: null,
    fallDistance: 0,
    remainingBlocks: 0,
    predictedDamage: 0,
    lethal: false,
    lastAction: "",
    inventoryOptions: []
  };
}

/**
 * Fall damage = max(0, floor(fallDistance) − 3) HP.
 * Feather Falling / Protection / Resistance.
 * @see https://minecraft.wiki/w/Damage#Fall_damage
 */
export function fallDamageHp(
  fallDistance: number,
  featherFallingLevel = 0,
  protectionLevel = 0,
  resistanceAmplifier = -1,
  landingMul = 1
): number {
  if (fallDistance <= 3 || landingMul <= 0) return 0;
  let dmg = Math.max(0, Math.floor(fallDistance) - 3);
  dmg = dmg * Math.min(1, Math.max(0, landingMul));
  const ffReduce = Math.min(0.48, Math.max(0, featherFallingLevel) * 0.12);
  const protReduce = Math.min(0.8, Math.max(0, protectionLevel) * 0.04);
  const armorReduce = Math.min(0.8, ffReduce + protReduce);
  dmg = dmg * (1 - armorReduce);
  if (resistanceAmplifier >= 0) {
    const resReduce = Math.min(1, (resistanceAmplifier + 1) * 0.2);
    dmg = dmg * (1 - resReduce);
  }
  return Math.max(0, Math.floor(dmg));
}

/**
 * MLG pencereleri (blocks):
 * - prepareFrom: bu yükseklikten ele al
 * - placeMax/Min: su/tekne place bandı (reach içi)
 *
 * Hız arttıkça placeMax biraz yükselir (paket gecikmesi for lead).
 */
function getBotPingMs(bot: Bot): number {
  try {
    const anyBot = bot as unknown as {
      player?: { ping?: number };
      players?: Record<string, { ping?: number }>;
      username?: string;
    };
    const ping = Number(anyBot.player?.ping ?? anyBot.players?.[bot.username]?.ping ?? 0);
    return Number.isFinite(ping) ? Math.max(0, Math.min(1_000, ping)) : 0;
  } catch {
    return 0;
  }
}

function mlgWindows(
  method: FallMethod,
  speed: number,
  cfgBase: number,
  pingMs = 0
): { prepareFrom: number; placeMax: number; placeMin: number } {
  // Hız ve ping yalnızca hazırlığı öne çeker; gerçek tıklama blok menzili forde kalır.
  const motionLead = Math.min(1.9, speed * 0.62);
  const pingLead = Math.min(0.9, (pingMs / 50) * speed * 0.12);
  const lead = motionLead + pingLead;

  if (method === "water" || method === "powder_snow") {
    const placeMax = Math.min(BLOCK_REACH - 0.08, Math.max(cfgBase - 1.25, 2.35) + lead);
    return {
      prepareFrom: Math.max(placeMax + 4.5, 11.5 + pingLead),
      placeMax,
      placeMin: 0.18
    };
  }
  if (method === "boat") {
    const placeMax = Math.min(BLOCK_REACH - 0.12, 3.25 + lead * 0.75);
    return { prepareFrom: placeMax + 5, placeMax, placeMin: 0.25 };
  }
  return {
    prepareFrom: Math.max(cfgBase + 7, 13),
    placeMax: Math.min(6.5, cfgBase + 1.7 + lead),
    placeMin: 0.35
  };
}

function resistanceAmplifier(bot: Bot): number {
  try {
    const effects = bot.entity.effects as unknown;
    const check = (name: string, amp?: number) => {
      if (/resistance/i.test(name) && !/fire.?resistance/i.test(name)) return amp ?? 0;
      return null;
    };
    if (Array.isArray(effects)) {
      for (const e of effects) {
        const name = String((e as { name?: string })?.name ?? "");
        const amp = Number((e as { amplifier?: number })?.amplifier ?? 0);
        const r = check(name, amp);
        if (r != null) return r;
      }
    } else if (effects && typeof effects === "object") {
      for (const [k, v] of Object.entries(effects as Record<string, unknown>)) {
        const name = String((v as { name?: string })?.name ?? k);
        const amp = Number((v as { amplifier?: number })?.amplifier ?? 0);
        const r = check(name, amp);
        if (r != null) return r;
      }
    }
  } catch {
    /* */
  }
  return -1;
}

function shouldIgnoreFall(bot: Bot): boolean {
  try {
    const ent = bot.entity as unknown as { elytraFlying?: boolean };
    if (ent.elytraFlying) return true;
    const gm = (bot as unknown as { game?: { gameMode?: string } }).game?.gameMode;
    if (gm === "creative" || gm === "spectator") return true;

    const effects = bot.entity.effects as unknown;
    if (Array.isArray(effects)) {
      for (const e of effects) {
        const name = String((e as { name?: string })?.name ?? "");
        if (/slow.?falling/i.test(name)) return true;
      }
    } else if (effects && typeof effects === "object") {
      for (const [k, v] of Object.entries(effects as Record<string, unknown>)) {
        if (/slow.?falling/i.test(k)) return true;
        const name = String((v as { name?: string })?.name ?? "");
        if (/slow.?falling/i.test(name)) return true;
      }
    }
  } catch {
    /* */
  }
  return false;
}

function isInLiquid(bot: Bot): boolean {
  try {
    if ((bot.entity as { isInWater?: boolean }).isInWater) return true;
    const p = bot.entity.position;
    for (const dy of [0, 1, -1]) {
      const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y) + dy, Math.floor(p.z)));
      if (b && (b.name === "water" || b.name.includes("water") || b.name === "lava" || b.name === "bubble_column")) {
        return true;
      }
    }
  } catch {
    /* */
  }
  return false;
}

/**
 * onGround bayrağı gecikebilir / kenarda false kalabilir.
 * Ayak altı blok + remaining distance + hız ile "yere değiyor" say.
 */
function isEffectivelyGrounded(bot: Bot): boolean {
  if (!bot.entity) return false;
  try {
    if (bot.entity.onGround) return true;
  } catch {
    /* */
  }
  if (isInLiquid(bot)) return true;

  const pos = bot.entity.position;
  const vy = bot.entity.velocity?.y ?? 0;

  // merdiven / scaffolding / vine: sakin tırmanma = grounded.
  // Hızlı aşağı (parkur/merdivenden düşüş) → grounded SAYMA — MLG devreye girebilsin.
  try {
    const at = bot.blockAt(v3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
    const above = bot.blockAt(v3(Math.floor(pos.x), Math.floor(pos.y) + 1, Math.floor(pos.z)));
    const names = [at, above].map((b) => b?.name?.replace(/^minecraft:/, "") ?? "");
    const onClimbable = names.some(
      (n) => n === "ladder" || n === "scaffolding" || n.includes("vine") || n === "cobweb" || n === "powder_snow"
    );
    if (onClimbable) {
      // cobweb / powder snow her zaman yumuşak
      if (names.some((n) => n === "cobweb" || n === "powder_snow")) return true;
      // merdivende kontrollü: yavaş veya yukarı — grounded
      if (vy > -0.38) return true;
      // merdivenden kopup hızla düşüyor → MLG serbest
      return false;
    }
  } catch {
    /* */
  }

  const land = findLandingBelow(bot);
  if (!land) return false;
  const rem = pos.y - land.standY;

  // neredeyse durmuş + yere çok yakın
  if (rem <= 0.35) return true;
  if (rem <= 0.85 && vy > -0.45) return true;
  // yavaşça iniyor ve 1 bloktan az
  if (rem <= 1.05 && vy > -0.35 && Math.abs(vy) < 0.55) return true;

  // ayak hizasının hemen altı dolu ve collision
  try {
    const belowY = Math.floor(pos.y - 0.12);
    const below = bot.blockAt(v3(Math.floor(pos.x), belowY, Math.floor(pos.z)));
    if (below && !isAirName(below.name) && !isFallThroughName(below.name)) {
      const top = belowY + (below.boundingBox === "block" || !below.boundingBox ? 1 : 0.5);
      if (pos.y - top <= 0.28 && vy > -0.6) return true;
    }
  } catch {
    /* */
  }

  return false;
}

function isInLavaNear(bot: Bot): boolean {
  try {
    const p = bot.entity.position;
    for (const dy of [0, 1, -1]) {
      for (const dx of [0, 1, -1]) {
        for (const dz of [0, 1, -1]) {
          const b = bot.blockAt(v3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz));
          if (b && (b.name === "lava" || b.name.includes("lava"))) return true;
        }
      }
    }
  } catch {
    /* */
  }
  return false;
}

function nearestHostileDist(bot: Bot): number | null {
  if (!bot.entity) return null;
  let best: number | null = null;
  try {
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      if (!isHostileMob(String(e.name ?? e.displayName ?? ""))) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (best == null || d < best) best = d;
    }
  } catch {
    /* */
  }
  return best;
}

/** Kaynak su / powder snow — en yakın (ayak / job civarı). Ot üstüne akmış suyu da bulur. */
function findNearestWaterSource(
  bot: Bot,
  cx: number,
  cy: number,
  cz: number,
  radius: number
): { x: number; y: number; z: number; name: string; dist: number } | null {
  if (!bot.entity) return null;
  const ex = bot.entity.position.x;
  const ey = bot.entity.position.y + ((bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62);
  const ez = bot.entity.position.z;

  let best: { x: number; y: number; z: number; name: string; dist: number } | null = null;
  for (let dy = -3; dy <= 4; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const bx = cx + dx;
        const by = cy + dy;
        const bz = cz + dz;
        const b = bot.blockAt(v3(bx, by, bz));
        if (!b) continue;
        const n = b.name.replace(/^minecraft:/, "");
        const isWater = n === "water" || n.includes("water") || n === "bubble_column";
        const isSnow = n === "powder_snow";
        if (!isWater && !isSnow) continue;

        // göz distancesi (reach)
        const dist = Math.hypot(bx + 0.5 - ex, by + 0.4 - ey, bz + 0.5 - ez);
        // kaynak tercihi: üstünde hava olan su biraz daha iyi
        const above = bot.blockAt(v3(bx, by + 1, bz));
        const openAbove = !above || isAirName(above.name) || isFallThroughName(above.name);
        const score = dist + (openAbove ? 0 : 0.35) + (isSnow ? 0.05 : 0);
        if (!best || score < best.dist) {
          best = { x: bx, y: by, z: bz, name: b.name, dist: score };
        }
      }
    }
  }
  return best;
}

/** @deprecated alias */
function findWaterBlockNear(
  bot: Bot,
  cx: number,
  cy: number,
  cz: number,
  radius: number
): { position: { x: number; y: number; z: number }; name: string } | null {
  const n = findNearestWaterSource(bot, cx, cy, cz, radius);
  if (!n) return null;
  return { position: { x: n.x, y: n.y, z: n.z }, name: n.name };
}

function hasWaterNear(bot: Bot, x: number, y: number, z: number): boolean {
  for (const dy of [0, 1, -1, 2]) {
    for (const dx of [0, 1, -1]) {
      for (const dz of [0, 1, -1]) {
        const b = bot.blockAt(v3(x + dx, y + dy, z + dz));
        if (b && (b.name === "water" || b.name.includes("water") || b.name === "bubble_column")) return true;
      }
    }
  }
  return false;
}

function hasPowderSnowNear(bot: Bot): boolean {
  try {
    const p = bot.entity.position;
    const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    return Boolean(b && b.name === "powder_snow");
  } catch {
    return false;
  }
}

function hasSoftNearFeet(bot: Bot): boolean {
  try {
    const p = bot.entity.position;
    for (const dy of [0, -1, 1]) {
      const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y) + dy, Math.floor(p.z)));
      if (!b) continue;
      const n = b.name.replace(/^minecraft:/, "");
      if (SOFT_LANDING.has(n) || n.includes("water")) return true;
    }
  } catch {
    /* */
  }
  return false;
}

function nearbyBoat(bot: Bot): boolean {
  try {
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      const n = String(e.name ?? e.displayName ?? "").toLowerCase();
      if (!n.includes("boat") && !n.includes("raft")) continue;
      if (bot.entity.position.distanceTo(e.position) < 3.5) return true;
    }
  } catch {
    /* */
  }
  return false;
}

function isAirName(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return n === "air" || n === "cave_air" || n === "void_air" || n === "light";
}

/** Yer bulunamazsa vy ile kaba remaining distance (kör) */
function estimateRemainingBlind(bot: Bot): number {
  const vy = Math.abs(bot.entity.velocity?.y ?? 1);
  // bilinmeyen zemin — agresif varsay: birkaç blok
  return Math.min(32, Math.max(4, vy * 8));
}

function armorFallEnchants(bot: Bot): { feather: number; protection: number } {
  let feather = 0;
  let protection = 0;
  try {
    const slots = [5, 6, 7, 8]
      .map((i) => bot.inventory.slots[i])
      .filter(Boolean) as Item[];
    for (const it of slots) {
      const list = getEnchants(it);
      for (const e of list) {
        const n = e.name.toLowerCase();
        if (n.includes("feather_falling") || n.includes("featherfalling") || n === "feather_falling") {
          feather = Math.max(feather, e.lvl);
        }
        if (
          (n === "protection" || n.endsWith(".protection") || n.includes("protection")) &&
          !n.includes("fire") &&
          !n.includes("blast") &&
          !n.includes("projectile")
        ) {
          protection += e.lvl;
        }
      }
    }
  } catch {
    /* */
  }
  return { feather, protection };
}

function getEnchants(it: Item): Array<{ name: string; lvl: number }> {
  const any = it as unknown as {
    enchants?: Array<{ name: string; lvl: number }>;
    nbt?: {
      value?: {
        Enchantments?: { value?: { value?: Array<{ name?: { value?: string }; id?: { value?: string }; lvl?: { value?: number } }> } };
      };
    };
  };
  if (Array.isArray(any.enchants) && any.enchants.length) {
    return any.enchants.map((e) => ({ name: String(e.name), lvl: Number(e.lvl) || 1 }));
  }
  try {
    const ench = any.nbt?.value?.Enchantments?.value?.value;
    if (Array.isArray(ench)) {
      return ench.map((e) => ({
        name: String(e.name?.value ?? e.id?.value ?? ""),
        lvl: Number(e.lvl?.value ?? 1)
      }));
    }
  } catch {
    /* */
  }
  return [];
}

interface LandingInfo {
  standY: number;
  soft: boolean;
  name: string;
  /** su MLG for uygun tam katı mı */
  waterPlaceable: boolean;
  /** katı bloğun y'si */
  solidY: number;
}

/** Aşağıdaki iniş yüzeyi: yumuşak (su/hay…) veya katı */
function findLandingBelow(bot: Bot): LandingInfo | null {
  if (!bot.entity) return null;
  const pos = bot.entity.position;
  const predicted = predictImpactXZ(bot, 8);

  const samples: Array<[number, number, number]> = [
    [predicted.x, predicted.z, 0],
    [predicted.x + 0.28, predicted.z, 0.1],
    [predicted.x - 0.28, predicted.z, 0.1],
    [predicted.x, predicted.z + 0.28, 0.1],
    [predicted.x, predicted.z - 0.28, 0.1],
    [pos.x, pos.z, 0.35]
  ];

  const seen = new Set<string>();
  let best: { info: LandingInfo; score: number } | null = null;
  for (const [sx, sz, sourcePenalty] of samples) {
    const x = Math.floor(sx);
    const z = Math.floor(sz);
    const key = x + "," + z;
    if (seen.has(key)) continue;
    seen.add(key);

    const info = scanColumn(bot, x, z, Math.floor(pos.y));
    if (!info) continue;
    const remaining = pos.y - info.standY;
    if (remaining < -0.2) continue;

    const impactDistance = Math.hypot(x + 0.5 - predicted.x, z + 0.5 - predicted.z);
    // Önce tahmini ayak izi; komşu yüksek çıkıntı yalnızca gerçekten rota üzerindeyse seçilir.
    const score = impactDistance * 3.2 + sourcePenalty + Math.max(0, remaining) * 0.006;
    if (!best || score < best.score) best = { info, score };
  }

  return best?.info ?? null;
}

function scanColumn(bot: Bot, x: number, z: number, startY: number): LandingInfo | null {
  const minY = Math.max(-64, startY - 96);
  for (let y = startY; y >= minY; y--) {
    const b = bot.blockAt(v3(x, y, z));
    if (!b) continue;
    const n = b.name.replace(/^minecraft:/, "");
    if (isFallThroughName(n)) continue;

    if (SOFT_LANDING.has(n) || n.includes("water") || n.endsWith("_carpet")) {
      // carpet hasar kesmez ama soft listede — waterPlaceable false
      const softWater = n.includes("water") || n === "bubble_column" || n === "powder_snow" || n === "cobweb" || n === "hay_block" || n === "slime_block";
      return {
        standY: y + (n.includes("water") || n === "bubble_column" ? 0 : 1),
        soft: softWater || SOFT_LANDING.has(n),
        name: n,
        waterPlaceable: false,
        solidY: y
      };
    }

    // yaprak vb. yine yere basılır (hasar alınır) ama su koyulmaz
    const placeable = isWaterPlaceableBlock(b);
    return {
      standY: y + 1,
      soft: false,
      name: n,
      waterPlaceable: placeable,
      solidY: y
    };
  }
  return null;
}

/** Reach forde su koyulabilir tam katı var mı? */
function hasWaterPlaceableNearby(bot: Bot, maxDown: number): boolean {
  return findBestWaterPlaceTarget(bot, maxDown) != null;
}

/**
 * Su koyulacak en iyi tam katı blok (x,y,z = solid block coords).
 * Yaprak/çit/slab atlanır; ayak altı tercih, yoksa 3x3 komşu.
 */
function predictImpactXZ(bot: Bot, maxTicks = 10): { x: number; z: number; ticks: number } {
  const pos = bot.entity.position;
  let x = pos.x;
  let z = pos.z;
  let vx = bot.entity.velocity?.x ?? 0;
  let vz = bot.entity.velocity?.z ?? 0;
  let vy = bot.entity.velocity?.y ?? -0.3;
  let fallen = 0;
  const landing = (() => {
    try {
      const current = scanColumn(bot, Math.floor(pos.x), Math.floor(pos.z), Math.floor(pos.y));
      return current ? Math.max(0, pos.y - current.standY) : 6;
    } catch {
      return 6;
    }
  })();

  let ticks = 0;
  while (ticks < Math.max(1, maxTicks) && fallen < landing) {
    x += vx;
    z += vz;
    fallen += Math.max(0, -vy);
    vx *= 0.91;
    vz *= 0.91;
    vy = (vy - 0.08) * 0.98;
    ticks++;
  }
  return { x, z, ticks };
}

function isReplaceableAboveForMlg(name0: string): boolean {
  const name = name0.replace(/^minecraft:/, "");
  if (isAirName(name) || isFallThroughName(name)) return true;
  if (name.includes("water") || name === "powder_snow" || name === "snow") return true;
  return false;
}

function canSeeMlgBlock(bot: Bot, block: unknown): boolean {
  try {
    const fn = (bot as unknown as { canSeeBlock?: (b: unknown) => boolean }).canSeeBlock;
    return typeof fn === "function" ? fn.call(bot, block) : true;
  } catch {
    return true;
  }
}

function findBestWaterPlaceTarget(
  bot: Bot,
  maxDown: number
): { x: number; y: number; z: number } | null {
  if (!bot.entity) return null;
  const pos = bot.entity.position;
  const eyeY = pos.y + ((bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62);
  const predicted = predictImpactXZ(bot, 10);
  const landing = findLandingBelow(bot);
  const desiredSolidY = landing?.solidY;
  const startY = Math.floor(pos.y);
  const minY = Math.max(-64, startY - Math.ceil(Math.min(8, Math.max(2, maxDown + 1.5))));

  const columns: Array<[number, number]> = [];
  const addColumn = (x: number, z: number) => {
    if (!columns.some(([cx, cz]) => cx === x && cz === z)) columns.push([x, z]);
  };
  const px = Math.floor(predicted.x);
  const pz = Math.floor(predicted.z);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) addColumn(px + dx, pz + dz);
  }
  addColumn(Math.floor(pos.x), Math.floor(pos.z));

  let best: { x: number; y: number; z: number } | null = null;
  let bestScore = Infinity;

  for (const [x, z] of columns) {
    const impactDistance = Math.hypot(x + 0.5 - predicted.x, z + 0.5 - predicted.z);
    if (impactDistance > 1.75) continue;

    for (let y = startY; y >= minY; y--) {
      const block = bot.blockAt(v3(x, y, z));
      if (!isWaterPlaceableBlock(block)) continue;
      if (!canSeeMlgBlock(bot, block)) continue;

      const above = bot.blockAt(v3(x, y + 1, z));
      if (above && !isReplaceableAboveForMlg(above.name)) continue;

      const tx = x + 0.5;
      const ty = y + 1;
      const tz = z + 0.5;
      const reach = Math.hypot(tx - pos.x, ty - eyeY, tz - pos.z);
      if (reach > BLOCK_REACH + 0.08) continue;

      const heightPenalty = desiredSolidY == null ? 0 : Math.abs(y - desiredSolidY) * 1.4;
      const score = impactDistance * 4 + heightPenalty + reach * 0.12;
      if (score < bestScore) {
        bestScore = score;
        best = { x, y, z };
      }
    }
  }

  return best;
}

function availableMethods(bot: Bot, banned: string[]): FallMethod[] {
  const items = bot.inventory.items().filter((i) => !banned.includes(i.name));
  const names = new Set(items.map((i) => i.name));
  const out: FallMethod[] = [];
  if (names.has("water_bucket")) out.push("water");
  if (names.has("powder_snow_bucket")) out.push("powder_snow");
  if ([...names].some((n) => BOAT_NAMES.includes(n) || n.endsWith("_boat") || n.endsWith("_raft"))) out.push("boat");
  if (names.has("hay_block")) out.push("hay");
  if (names.has("slime_block")) out.push("slime");
  if (names.has("cobweb")) out.push("cobweb");
  if (names.has("ladder") || names.has("vine")) out.push("ladder");
  if (names.has("scaffolding")) out.push("scaffolding");
  return out;
}

function pickBestMethod(
  options: FallMethod[],
  remaining: number,
  lethal: boolean,
  predictedDamage: number,
  speed: number
): FallMethod {
  if (!options.length) return "none";
  const score: Record<FallMethod, number> = {
    water: 100,
    powder_snow: 95,
    boat: 88,
    hay: 75,
    slime: 70,
    cobweb: 60,
    ladder: 55,
    scaffolding: 50,
    none: 0
  };
  // düşük hasarda blok yastık da olur
  if (!lethal && predictedDamage < 8) {
    score.hay += 10;
    score.slime += 5;
  }
  // çok hızlı düşüşte su en güvenilir
  if (speed > 1.2) {
    score.water += 15;
    score.powder_snow += 10;
  }
  if (remaining < 1.5) {
    score.boat += 12;
    score.water += 5;
  }
  let best: FallMethod = "none";
  let bestS = -1;
  for (const m of options) {
    const s = score[m] ?? 0;
    if (s > bestS) {
      bestS = s;
      best = m;
    }
  }
  return best;
}

function findItemForMethod(bot: Bot, method: FallMethod, banned: string[]): Item | null {
  const items = bot.inventory.items().filter((i) => !banned.includes(i.name));
  switch (method) {
    case "water":
      return items.find((i) => i.name === "water_bucket") ?? null;
    case "powder_snow":
      return items.find((i) => i.name === "powder_snow_bucket") ?? null;
    case "boat":
      return items.find((i) => BOAT_NAMES.includes(i.name) || i.name.endsWith("_boat") || i.name.endsWith("_raft")) ?? null;
    case "hay":
      return items.find((i) => i.name === "hay_block") ?? null;
    case "slime":
      return items.find((i) => i.name === "slime_block") ?? null;
    case "cobweb":
      return items.find((i) => i.name === "cobweb") ?? null;
    case "ladder":
      return items.find((i) => i.name === "ladder" || i.name === "vine") ?? null;
    case "scaffolding":
      return items.find((i) => i.name === "scaffolding") ?? null;
    default:
      return null;
  }
}

/** Düşerken anında yere bak — force=true, bekleme yok */
async function snapLookDown(bot: Bot) {
  if (!bot.entity) return;
  try {
    // force: yumuşak dönüş yok, anında pitch
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
  } catch {
    try {
      await bot.look(bot.entity.yaw, -1.55, true);
    } catch {
      try {
        // son çare: pitch alanı
        (bot.entity as { pitch: number }).pitch = -Math.PI / 2;
      } catch {
        /* */
      }
    }
  }
}

async function snapLookAt(bot: Bot, x: number, y: number, z: number) {
  try {
    await bot.lookAt(v3(x, y, z), true);
  } catch {
    await snapLookDown(bot);
  }
}

/** @deprecated use snapLookDown */
async function lookDown(bot: Bot) {
  return snapLookDown(bot);
}

/** 1.19+ use_item — bazı sunucularda activateItem kovada yetmez */
function tryUseItemPacket(bot: Bot) {
  try {
    const client = (bot as unknown as { _client?: { write: (n: string, d: unknown) => void } })._client;
    if (!client) return;
    // sequence alanı 1.19+; eski protokol yok sayar / hata yutar
    try {
      client.write("use_item", { hand: 0, sequence: 1, rotation: { x: 0, y: 0, z: 0 } });
    } catch {
      try {
        client.write("block_place", {
          location: bot.entity.position.offset(0, -1, 0).floored?.() ?? bot.entity.position,
          direction: 1,
          hand: 0,
          cursorX: 0.5,
          cursorY: 1,
          cursorZ: 0.5
        });
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/** Inventory has insufficient item sayısı (stack’ler toplam) — held çift sayılmaz (items() hotbar içerir) */
export function countItemName(bot: Bot, name: string): number {
  let n = 0;
  try {
    for (const it of bot.inventory.items()) {
      if (it.name === name) n += it.count ?? 1;
    }
  } catch {
    /* */
  }
  return n;
}

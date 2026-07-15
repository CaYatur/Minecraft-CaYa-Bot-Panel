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
  /** Sadece tehlikeli/ölümcül düşüşte müdahale */
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
  // 4.5 blok raycast sınırına yakın erken tetik — asıl yerleştirme daha alçakta
  mlgTriggerBlocks: 5.5,
  onlyWhenDangerous: true,
  autoReclaim: true,
  reclaimWater: true,
  reclaimBoat: true,
  reclaimBlocks: true
};

/** MLG sonrası geri alınacak yerleştirme kaydı */
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
  /** bu zamana kadar dene */
  deadline: number;
  /** su = yüksek öncelik */
  priority: number;
  /** isteğe bağlı blok adı (kırılacak) */
  blockName?: string;
  /** peş peşe güvensiz tick — vakit kaybını kes */
  unsafeStreak?: number;
  /** MLG sonrası hedef dolu kova sayısı (geri alınca buna ulaş) */
  wantFilledCount?: number;
  filledName?: string;
  usedBuckets?: number;
}

/** Blok etkileşim menzili (su koyabilmek için katı bloğa bakış) */
const BLOCK_REACH = 4.45;

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
 * Su/tekne MLG için kötü yüzey — yaprak, çit, cam paneli, karpet vb.
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
  if (n.includes("chest") || n.includes("barrel") || n === "ender_chest") return true; // üstü garip
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
 * Yüksekten düşerken hasar almamak / ölmemek için MLG ve yumuşak iniş.
 * Pathfinder/görevlerden bağımsız, tick bazlı.
 */
export class FallGuardService {
  private bot: Bot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
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
        ? `geri-al kuyruk:${this.recoverJobs.map((j) => j.method).join(",")}`
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
    this.recoverJobs = [];
    this.fallPeakY = null;
    this.state = idleState();
  }

  /** MLG yerleştirme kaydı — sonra geri alınacak */
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

    // aynı method için tek iş (konum sonrakine güncellenir)
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
      "MLG geri-al kuyruğa",
      `${method} @${job.x},${job.y},${job.z}${job.wantFilledCount != null ? ` · hedef dolu=${job.wantFilledCount}` : ""}`
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
        this.state.lastAction = "düşüş yok sayıldı (efekt/mod)";
        this.emit(true);
      }
      return;
    }

    // --- MLG malzeme geri alma (iniş sonrası / güvenli an) ---
    if (this.recoverJobs.length && !this.busy && !this.reclaimBusy) {
      void this.processRecoverQueue(bot);
    }

    if (bot.entity.onGround || isInLiquid(bot)) {
      if (this.state.falling || this.state.active || this.fallPeakY != null) {
        this.state = idleState();
        this.state.lastAction =
          this.recoverJobs.length > 0 ? `iniş tamam · geri-al bekliyor (${this.recoverJobs.length})` : "iniş tamam";
        this.fallPeakY = null;
        this.emit(true);
      }
      // yere bastıktan sonra da reclaim tick'te işlenir
      return;
    }

    const vy = bot.entity.velocity?.y ?? 0;
    const metaFall = Number((bot.entity as { fallDistance?: number }).fallDistance ?? 0);
    const feetY = bot.entity.position.y;
    // daha hassas düşüş algısı (küçük vy de düşüş olabilir)
    const falling = vy < -0.15 || metaFall > 0.8 || (this.fallPeakY != null && feetY < this.fallPeakY - 0.4);
    if (!falling) {
      if (this.state.falling) {
        this.state.falling = false;
        this.fallPeakY = null;
        this.emit(true);
      }
      // havada değil, yerde de değil (nadir) — yine reclaim dene
      return;
    }

    if (this.fallPeakY == null || feetY > this.fallPeakY) {
      this.fallPeakY = feetY;
    }

    const groundInfo = findLandingBelow(bot);
    if (groundInfo?.soft) {
      const remSoft = Math.max(0, feetY - groundInfo.standY);
      if (remSoft < 10) {
        this.state = {
          active: false,
          falling: true,
          method: null,
          fallDistance: round1(Math.max(metaFall, (this.fallPeakY ?? feetY) - groundInfo.standY)),
          remainingBlocks: round1(remSoft),
          predictedDamage: 0,
          lethal: false,
          lastAction: `yumuşak iniş: ${groundInfo.name}`,
          inventoryOptions: availableMethods(bot, this.instance.config.inventory.bannedItems)
        };
        this.emit();
        return;
      }
    }

    const remaining = groundInfo != null ? Math.max(0, feetY - groundInfo.standY) : estimateRemainingBlind(bot);
    const fromPeak =
      groundInfo != null && this.fallPeakY != null ? Math.max(0, this.fallPeakY - groundInfo.standY) : remaining;
    // en iyi düşüş mesafesi tahmini: meta + kalan veya peak
    const bestFall = Math.max(
      metaFall > 0.2 ? metaFall + Math.max(0, remaining - 0.25) : 0,
      fromPeak,
      metaFall
    );

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

    if (this.busy) {
      this.emit();
      return;
    }
    // başarısız MLG sonrası hızlı yeniden dene
    if (Date.now() - this.lastMlgAt < 120) return;

    const method = pickBestMethod(options, remaining, lethal, predictedDamage, Math.abs(vy));
    if (method === "none") {
      if (lethal) void this.tryEquipTotem(bot);
      this.state.lastAction = lethal ? "kurtarma yok — totem/ölümcül!" : "kurtarma malzemesi yok";
      this.emit();
      if (lethal && Date.now() - this.lastWarnAt > 3000) {
        this.lastWarnAt = Date.now();
        this.log().warn("Ölümcül düşüş — MLG malzemesi yok", `~${predictedDamage} HP · ${bestFall.toFixed(1)} blok`);
      }
      return;
    }

    // su için kötü yüzey (yaprak/ot vb.) → tekne/blok yastığa kay
    type PlaceMethod = Exclude<FallMethod, "none">;
    let chosen: PlaceMethod = method as PlaceMethod;
    if ((chosen === "water" || chosen === "powder_snow") && !hasWaterPlaceableNearby(bot, remaining + 1)) {
      const altOrder: PlaceMethod[] = ["boat", "hay", "slime", "cobweb", "scaffolding", "ladder"];
      const alt = altOrder.find((m) => options.includes(m));
      if (alt) {
        chosen = alt;
        this.state.lastAction = `yüzey kötü (yaprak/ot?) → ${alt}`;
      }
    }

    // --- dinamik tetik penceresi ---
    const windows = mlgWindows(chosen, Math.abs(vy), cfg.mlgTriggerBlocks);
    // düşerken mümkün olduğunca hızlı yere bak (hazırlık + bekleme)
    if (chosen === "water" || chosen === "powder_snow" || chosen === "boat") {
      void snapLookDown(bot);
    }

    // hazırlık: hâlâ yüksekte — kova/blok ele
    if (remaining > windows.prepareFrom) {
      if (!this.busy) void this.preEquip(bot, chosen);
      this.state.method = chosen;
      this.state.lastAction = `hazırlık: ${chosen} (${remaining.toFixed(1)}m · v=${Math.abs(vy).toFixed(2)})`;
      this.emit();
      return;
    }

    // yerleştirme penceresi: çok yüksekte raycast vurmaz; çok alçakta geç kalınır
    if (remaining > windows.placeMax) {
      if (!this.busy) void this.preEquip(bot, chosen);
      this.state.method = chosen;
      this.state.lastAction = `bekle: ${chosen} @${windows.placeMax.toFixed(1)}m (şimdi ${remaining.toFixed(1)})`;
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
      `Düşüş kurtarma: ${chosen}`,
      `kalan ${remaining.toFixed(1)} · hasar≈${predictedDamage} HP · düşüş≈${bestFall.toFixed(1)} · vY=${vy.toFixed(2)} · pencere ${windows.placeMin.toFixed(1)}–${windows.placeMax.toFixed(1)}${lethal ? " ÖLÜMCÜL" : ""}`
    );

    try {
      try {
        (bot as { pathfinder?: { setGoal: (g: null) => void } }).pathfinder?.setGoal(null);
      } catch {
        /* */
      }
      // yatay hareketi kes — su yanına kaçmasın
      try {
        for (const k of ["forward", "back", "left", "right", "sprint"] as const) {
          bot.setControlState(k, false);
        }
      } catch {
        /* */
      }

      // yerleştirmeden hemen önce anında yere bak
      await snapLookDown(bot);

      const ok = await this.executeMethod(bot, chosen, remaining);
      if (ok) {
        this.lastMlgAt = Date.now();
        this.state.lastAction = `uygulandı: ${chosen}`;
        this.log().info(`MLG başarılı: ${chosen}`, `kalan≈${(bot.entity?.position.y ?? 0).toFixed(1)}`);
        // iniş sonrası geri alma — su neredeyse kesin
        this.scheduleReclaimAfterLand(chosen);
      } else {
        // hızlı retry izni
        this.lastMlgAt = Date.now() - 50;
        this.state.lastAction = `başarısız: ${chosen} — yeniden denenecek`;
        this.log().warn("Düşüş kurtarma yerleşmedi", `${chosen} · kalan ${remaining.toFixed(1)}`);
      }
    } catch (e) {
      this.lastMlgAt = Date.now() - 50;
      this.state.lastAction = `hata: ${e instanceof Error ? e.message : String(e)}`;
      this.log().warn("Düşüş kurtarma başarısız", e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
      this.state.active = false;
      this.emit(true);
    }
  }

  private async preEquip(bot: Bot, method: FallMethod) {
    const item = findItemForMethod(bot, method, this.instance.config.inventory.bannedItems);
    if (!item) return;
    try {
      // önce bakış (kova takmadan da yere kilitlen)
      if (method === "water" || method === "powder_snow" || method === "boat") {
        await snapLookDown(bot);
      }
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      if (method === "water" || method === "powder_snow" || method === "boat") {
        await snapLookDown(bot);
      }
    } catch {
      /* */
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
      this.log().info("Totem of Undying sol ele alındı (ölümcül düşüş)");
      this.emit(true);
    } catch {
      try {
        await bot.equip(totem, "hand");
        this.state.lastAction = "totem ana el";
      } catch {
        /* */
      }
    }
  }

  /** inişten sonra reclaim tetiklensin diye (su öncelikli) */
  private scheduleReclaimAfterLand(method: FallMethod) {
    // place* metodları zaten enqueueRecover çağırır; burada sadece hatırlatma log
    if (method === "water" || method === "powder_snow") {
      this.state.lastAction = `uygulandı: ${method} · su geri alınacak`;
    } else {
      this.state.lastAction = `uygulandı: ${method} · malzeme geri alınacak`;
    }
  }

  /** @returns true if placement likely succeeded */
  private async executeMethod(bot: Bot, method: FallMethod, remaining: number): Promise<boolean> {
    const banned = this.instance.config.inventory.bannedItems;
    const item = findItemForMethod(bot, method, banned);
    if (!item) throw new Error(`${method} eşyası yok`);

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
   * Çok yüksekte activateItem sessizce başarısız olur.
   */
  private async placeBucketMlg(bot: Bot, item: Item, method: FallMethod): Promise<boolean> {
    const filledName = method === "powder_snow" ? "powder_snow_bucket" : "water_bucket";
    // düşüş öncesi / yerleştirme öncesi sayım (çoklu kova)
    const filledBefore = countItemName(bot, filledName);
    const emptyBefore = countItemName(bot, "bucket");

    try {
      await snapLookDown(bot);
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      await snapLookDown(bot);
    } catch {
      return false;
    }

    const markSuccess = (x: number, y: number, z: number, why: string) => {
      const filledAfter = countItemName(bot, filledName);
      const emptyAfter = countItemName(bot, "bucket");
      // geri al: en az bir dolu kova eksildiyse onu geri getir
      const used = Math.max(1, filledBefore - filledAfter, emptyAfter > emptyBefore ? 1 : 0);
      this.enqueueRecover(method, { x, y, z }, {
        wantFilledCount: filledAfter + used,
        filledName,
        usedBuckets: used
      });
      this.log().info(
        `MLG su yerleşti (${why})`,
        `${filledName} ${filledBefore}→${filledAfter} · boş ${emptyBefore}→${emptyAfter} · geri-al hedef ${filledAfter + used}`
      );
      return true;
    };

    const inventorySaysPlaced = () => {
      const filledAfter = countItemName(bot, filledName);
      const emptyAfter = countItemName(bot, "bucket");
      // dolu azaldı VEYA boş arttı (çoklu kova senaryosu)
      return filledAfter < filledBefore || emptyAfter > emptyBefore;
    };

    for (let attempt = 0; attempt < 18; attempt++) {
      if (!bot.entity || this.instance.status !== "online") return false;

      // envanter delta — sunucu su bloğunu gecikmeli gösterebilir
      if (inventorySaysPlaced()) {
        const p = bot.entity.position;
        const t = findBestWaterPlaceTarget(bot, 4);
        return markSuccess(
          t?.x ?? Math.floor(p.x),
          t ? t.y + 1 : Math.floor(p.y),
          t?.z ?? Math.floor(p.z),
          "envanter"
        );
      }

      if (bot.entity.onGround && (isInLiquid(bot) || hasSoftNearFeet(bot))) {
        const p = bot.entity.position;
        return markSuccess(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), "iniş-su");
      }
      if (isInLiquid(bot) || (method === "powder_snow" && hasPowderSnowNear(bot))) {
        const p = bot.entity.position;
        return markSuccess(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), "sıvı");
      }

      const land = findLandingBelow(bot);
      const feetY = bot.entity.position.y;
      const rem = land ? feetY - land.standY : 99;

      if (rem > BLOCK_REACH + 0.15) {
        await snapLookDown(bot);
        await sleep(25);
        continue;
      }

      const target = findBestWaterPlaceTarget(bot, rem);
      if (!target) {
        await snapLookDown(bot);
        this.state.lastAction = "MLG: uygun katı yok (yaprak/çit?)";
        await sleep(30);
        continue;
      }

      const solid = bot.blockAt(v3(target.x, target.y, target.z));
      const above = bot.blockAt(v3(target.x, target.y + 1, target.z));

      if (above && (above.name.includes("water") || above.name === "powder_snow")) {
        return markSuccess(target.x, target.y + 1, target.z, "zaten-su");
      }

      if (solid && isWaterPlaceableBlock(solid)) {
        try {
          await bot.lookAt(v3(target.x + 0.5, target.y + 0.99, target.z + 0.5), true);
        } catch {
          await snapLookDown(bot);
        }
      } else {
        await snapLookDown(bot);
        await sleep(20);
        continue;
      }

      if (bot.heldItem?.name !== item.name) {
        const again = bot.inventory.items().find((i) => i.name === item.name);
        if (again) {
          try {
            await bot.equip(again, "hand");
            await snapLookAt(bot, target.x + 0.5, target.y + 0.99, target.z + 0.5);
          } catch {
            return false;
          }
        } else {
          // elinde yok — belki zaten kullandı
          if (inventorySaysPlaced()) {
            return markSuccess(target.x, target.y + 1, target.z, "kova-bitti");
          }
          return false;
        }
      }

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

      if (solid && isWaterPlaceableBlock(solid) && countItemName(bot, filledName) >= filledBefore) {
        try {
          await bot.activateBlock(solid);
        } catch {
          /* */
        }
        await sleep(30);
      }

      if (countItemName(bot, filledName) >= filledBefore) {
        tryUseItemPacket(bot);
        await sleep(30);
      }

      // kısa bekle — paket/sync
      await sleep(40);

      // 1) envanter (birincil doğruluk — çoklu kova)
      if (inventorySaysPlaced()) {
        return markSuccess(target.x, target.y + 1, target.z, "envanter-sonra");
      }
      // 2) dünya
      if (isInLiquid(bot) || hasWaterNear(bot, target.x, target.y + 1, target.z) || hasPowderSnowNear(bot)) {
        return markSuccess(target.x, target.y + 1, target.z, "dünya");
      }

      await sleep(30);
    }

    // son şans envanter
    if (inventorySaysPlaced()) {
      const p = bot.entity?.position;
      if (p) return markSuccess(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), "final-envanter");
    }
    const softOk = isInLiquid(bot) || hasSoftNearFeet(bot);
    if (softOk && bot.entity) {
      const p = bot.entity.position;
      return markSuccess(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), "soft");
    }
    this.log().warn(
      "MLG su yerleşmedi",
      `${filledName} ${filledBefore}→${countItemName(bot, filledName)} · boş ${emptyBefore}→${countItemName(bot, "bucket")}`
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
   * Güvenli mi? Zor durumda (can kritik, yanıyor, yakın düşman dövüşü, düşüşte)
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
      return { ok: false, reason: "hâlâ düşüyor" };
    }

    // ateş / lav — önce kaç
    try {
      if ((bot as { onFire?: boolean }).onFire) return { ok: false, reason: "yanıyor" };
    } catch {
      /* */
    }
    if (isInLavaNear(bot)) return { ok: false, reason: "lav" };

    // can çok düşük — su yine de al (kova hayati); blok/tekne ertele
    if (hp <= 4 && !isWater) return { ok: false, reason: "can kritik" };

    // dövüş: yakın hostile ve can düşükse ertele (su: sadece mob ≤2.5m ve can≤6)
    const nearThreat = nearestHostileDist(bot);
    if (nearThreat != null) {
      if (isWater) {
        if (nearThreat < 2.2 && hp <= 6) return { ok: false, reason: "yakın düşman+düşük can" };
      } else if (nearThreat < 4.5) {
        return { ok: false, reason: "yakın düşman" };
      }
    }

    // combat mode saldırı/savunma + çok yakın tehdit
    try {
      const mode = this.instance.combat?.getRuntime?.()?.mode;
      if (mode === "fleeing") return { ok: false, reason: "kaçış" };
      if ((mode === "attacking" || mode === "defending") && nearThreat != null && nearThreat < 3 && !isWater) {
        return { ok: false, reason: "dövüş" };
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
      // güvensiz: vakit kaybetme — sayaç artır, kısa süre sonra vazgeç
      job.unsafeStreak = (job.unsafeStreak ?? 0) + 1;
      job.lastTryAt = now;
      const isWater = job.method === "water" || job.method === "powder_snow";
      // tehdit/kaçış/yanma: su için de çabuk bırak (hayati değil, hayatta kal)
      const hardUnsafe =
        safety.reason === "kaçış" ||
        safety.reason === "yanıyor" ||
        safety.reason === "lav" ||
        safety.reason === "yakın düşman+düşük can" ||
        safety.reason === "hâlâ düşüyor";
      if (hardUnsafe && job.unsafeStreak >= (isWater ? 3 : 1)) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `geri-al iptal (güvensiz: ${safety.reason})`;
        this.log().info("MLG geri-al ertelendi/iptal", `${job.method} · ${safety.reason}`);
        this.emit(true);
        return;
      }
      if (!isWater && job.unsafeStreak >= 2) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `geri-al iptal: ${job.method} (${safety.reason})`;
        return;
      }
      // su: biraz bekle (iniş oturması) ama sonsuza kadar uğraşma
      if (isWater && job.unsafeStreak >= 12) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `geri-al vazgeçildi (sürekli güvensiz)`;
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
        this.state.lastAction = `geri alındı: ${job.method}`;
        this.log().info(`MLG malzeme geri alındı: ${job.method}`, `@${job.x},${job.y},${job.z}`);
        this.emit(true);
      } else if (job.tries >= (job.method === "water" ? 16 : 10) || now > job.deadline) {
        this.recoverJobs = this.recoverJobs.filter((j) => j.id !== job.id);
        this.state.lastAction = `geri-al vazgeçildi: ${job.method}`;
        this.log().warn(`MLG geri-al başarısız: ${job.method}`, `${job.tries} deneme`);
        this.emit(true);
      } else {
        this.state.lastAction = `geri-al deniyor: ${job.method} (#${job.tries})`;
      }
    } catch (e) {
      this.log().debug("MLG geri-al hata", e instanceof Error ? e.message : String(e));
    } finally {
      this.reclaimBusy = false;
    }
  }

  /**
   * Su / powder snow kovaya geri al.
   * Başarı = envanter dolu kova sayısı hedefe ulaştı (çoklu kova güvenli).
   * Dünya taraması: ayak + job + geniş — ot/yaprak üstüne akmış suyu bulur.
   */
  private async reclaimWater(bot: Bot, job: MlgRecoverJob): Promise<boolean> {
    const filledName =
      job.filledName ?? (job.method === "powder_snow" ? "powder_snow_bucket" : "water_bucket");
    const filledNow = countItemName(bot, filledName);
    const want = job.wantFilledCount ?? filledNow + (job.usedBuckets ?? 1);

    // hedef dolu kova sayısına ulaşıldı
    if (filledNow >= want) {
      this.log().info("MLG su geri-al OK (envanter)", `${filledName}=${filledNow} ≥ ${want}`);
      return true;
    }

    const emptyItem =
      bot.inventory.items().find((i) => i.name === "bucket") ??
      (bot.heldItem?.name === "bucket" ? bot.heldItem : null);

    if (!emptyItem) {
      // boş kova yok ama hedefe ulaşmadık — belki başka yoldan doldu
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
      // su yok — hedefe ulaştıysak OK, değilse birkaç deneme sonra bırak
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
        this.log().info("MLG su geri-al OK", `${filledName} ${before}→${after} (hedef ${want})`);
        return after >= want || after > before;
      }
      const s = this.isSafeToReclaim(bot, job);
      if (!s.ok && s.reason !== "hâlâ düşüyor") return false;
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
    // kayıt noktasına yakın
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
      // tekne yok — belki kırıldı / despawn; envanterde varsa OK
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
      // blok yok — alındı veya yok oldu
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
 * MLG pencereleri (blok):
 * - prepareFrom: bu yükseklikten ele al
 * - placeMax/Min: su/tekne yerleştirme bandı (reach içi)
 *
 * Hız arttıkça placeMax biraz yükselir (paket gecikmesi için lead).
 */
function mlgWindows(
  method: FallMethod,
  speed: number,
  cfgBase: number
): { prepareFrom: number; placeMax: number; placeMin: number } {
  // lead: hız * ~3 tick (~150ms) mesafe
  const lead = Math.min(1.8, speed * 0.55);
  if (method === "water" || method === "powder_snow") {
    // reach 4.5 — asıl yerleştirme 1.4–4.2 arası; lead ile üst
    const placeMax = Math.min(BLOCK_REACH - 0.15, Math.max(cfgBase - 1.2, 2.2) + lead);
    const placeMin = 0.35;
    return { prepareFrom: Math.max(placeMax + 3, 10), placeMax, placeMin };
  }
  if (method === "boat") {
    const placeMax = Math.min(BLOCK_REACH - 0.2, 3.2 + lead * 0.8);
    return { prepareFrom: placeMax + 4, placeMax, placeMin: 0.4 };
  }
  // blok yastık (hay/slime/cobweb): biraz daha yüksekten koy
  return {
    prepareFrom: Math.max(cfgBase + 6, 12),
    placeMax: Math.min(6.5, cfgBase + 1.5 + lead),
    placeMin: 0.5
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

        // göz mesafesi (reach)
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

/** Yer bulunamazsa vy ile kaba kalan mesafe (kör) */
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
  /** su MLG için uygun tam katı mı */
  waterPlaceable: boolean;
  /** katı bloğun y'si */
  solidY: number;
}

/** Aşağıdaki iniş yüzeyi: yumuşak (su/hay…) veya katı */
function findLandingBelow(bot: Bot): LandingInfo | null {
  const pos = bot.entity.position;
  // ayak izi — birkaç xz dene (kenarda düşüş)
  const bases = [
    [Math.floor(pos.x), Math.floor(pos.z)],
    [Math.floor(pos.x + 0.3), Math.floor(pos.z)],
    [Math.floor(pos.x - 0.3), Math.floor(pos.z)],
    [Math.floor(pos.x), Math.floor(pos.z + 0.3)],
    [Math.floor(pos.x), Math.floor(pos.z - 0.3)]
  ] as const;

  let best: LandingInfo | null = null;
  for (const [x, z] of bases) {
    const info = scanColumn(bot, x, z, Math.floor(pos.y));
    if (!info) continue;
    if (!best || info.standY > best.standY) best = info; // en yüksek (en yakın) zemin
  }
  return best;
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

/** Reach içinde su koyulabilir tam katı var mı? */
function hasWaterPlaceableNearby(bot: Bot, maxDown: number): boolean {
  return findBestWaterPlaceTarget(bot, maxDown) != null;
}

/**
 * Su koyulacak en iyi tam katı blok (x,y,z = solid block coords).
 * Yaprak/çit/slab atlanır; ayak altı tercih, yoksa 3x3 komşu.
 */
function findBestWaterPlaceTarget(bot: Bot, maxDown: number): { x: number; y: number; z: number } | null {
  if (!bot.entity) return null;
  const pos = bot.entity.position;
  const eyeY = pos.y + ((bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62);
  const fx = Math.floor(pos.x);
  const fz = Math.floor(pos.z);
  const startY = Math.floor(pos.y);
  const minY = Math.max(-64, startY - Math.ceil(Math.min(8, Math.max(2, maxDown + 2))));

  let best: { x: number; y: number; z: number } | null = null;
  let bestScore = Infinity;

  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let y = startY; y >= minY; y--) {
        const b = bot.blockAt(v3(fx + dx, y, fz + dz));
        if (!isWaterPlaceableBlock(b)) continue;
        // üstü su koyulabilir mi (hava veya replaceable)
        const above = bot.blockAt(v3(fx + dx, y + 1, fz + dz));
        if (above) {
          const an = above.name.replace(/^minecraft:/, "");
          if (!isAirName(an) && !an.includes("water") && !isFallThroughName(an) && !isBadWaterSurfaceName(an) && an !== "snow") {
            // dolu üst — atla (yaprak üstü dahil — yaprak bad surface, skip if leaf above solid)
            if (!isBadWaterSurfaceName(an)) continue;
            // üstünde yaprak varsa bu katıya bakış engellenir — atla
            if (an.includes("leaves") || an.includes("leaf")) continue;
          }
        }
        // mesafe (göz → tepe)
        const tx = fx + dx + 0.5;
        const ty = y + 1;
        const tz = fz + dz + 0.5;
        const dist = Math.hypot(tx - pos.x, ty - eyeY, tz - pos.z);
        if (dist > BLOCK_REACH + 0.35) continue;
        // skor: yakın + ayak altı bonus
        const horiz = Math.abs(dx) + Math.abs(dz);
        const score = dist + horiz * 0.35 + (horiz === 0 ? 0 : 0.4);
        if (score < bestScore) {
          bestScore = score;
          best = { x: fx + dx, y, z: fz + dz };
        }
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

/** Envanterde item sayısı (stack’ler toplam) — held çift sayılmaz (items() hotbar içerir) */
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

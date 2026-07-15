import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { BotInstance } from "../../core/BotInstance";
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
}

export const DEFAULT_FALL_GUARD: FallGuardConfig = {
  enabled: true,
  minDamageHp: 4,
  lethalHealthMargin: 2,
  // 4.5 blok raycast sınırına yakın erken tetik — asıl yerleştirme daha alçakta
  mlgTriggerBlocks: 5.5,
  onlyWhenDangerous: true
};

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
 * Yüksekten düşerken hasar almamak / ölmemek için MLG ve yumuşak iniş.
 * Pathfinder/görevlerden bağımsız, tick bazlı.
 */
export class FallGuardService {
  private bot: Bot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastMlgAt = 0;
  private lastEmitAt = 0;
  private lastWarnAt = 0;
  private fallPeakY: number | null = null;
  private placedWaterPos: { x: number; y: number; z: number } | null = null;
  private state: FallGuardState = idleState();

  constructor(private readonly instance: BotInstance) {}

  getState(): FallGuardState {
    return { ...this.state, inventoryOptions: [...this.state.inventoryOptions] };
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
    this.placedWaterPos = null;
    this.fallPeakY = null;
    this.state = idleState();
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

    if (bot.entity.onGround || isInLiquid(bot)) {
      if (this.placedWaterPos) void this.tryPickupWater(bot);
      if (this.state.falling || this.state.active || this.fallPeakY != null) {
        this.state = idleState();
        this.state.lastAction = "iniş tamam";
        this.fallPeakY = null;
        this.emit(true);
      }
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

    // --- dinamik tetik penceresi ---
    const windows = mlgWindows(method, Math.abs(vy), cfg.mlgTriggerBlocks);
    // hazırlık: hâlâ yüksekte — kova/blok ele
    if (remaining > windows.prepareFrom) {
      if (!this.busy) void this.preEquip(bot, method);
      this.state.method = method;
      this.state.lastAction = `hazırlık: ${method} (${remaining.toFixed(1)}m · v=${Math.abs(vy).toFixed(2)})`;
      this.emit();
      return;
    }

    // yerleştirme penceresi: çok yüksekte raycast vurmaz; çok alçakta geç kalınır
    if (remaining > windows.placeMax) {
      if (!this.busy) void this.preEquip(bot, method);
      this.state.method = method;
      this.state.lastAction = `bekle: ${method} @${windows.placeMax.toFixed(1)}m (şimdi ${remaining.toFixed(1)})`;
      this.emit();
      return;
    }
    if (remaining < windows.placeMin && method !== "ladder" && method !== "scaffolding") {
      // neredeyse yere bastı — son şans yine de dene
      if (remaining < 0.25) {
        this.emit();
        return;
      }
    }

    this.busy = true;
    this.state.active = true;
    this.state.method = method;
    this.state.lastAction = `MLG: ${method}`;
    this.emit(true);
    this.log().info(
      `Düşüş kurtarma: ${method}`,
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

      const ok = await this.executeMethod(bot, method, remaining);
      if (ok) {
        this.lastMlgAt = Date.now();
        this.state.lastAction = `uygulandı: ${method}`;
        this.log().info(`MLG başarılı: ${method}`, `kalan≈${(bot.entity?.position.y ?? 0).toFixed(1)}`);
      } else {
        // hızlı retry izni
        this.lastMlgAt = Date.now() - 50;
        this.state.lastAction = `başarısız: ${method} — yeniden denenecek`;
        this.log().warn("Düşüş kurtarma yerleşmedi", `${method} · kalan ${remaining.toFixed(1)}`);
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
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      // su için önceden aşağı bak
      if (method === "water" || method === "powder_snow" || method === "boat") {
        await lookDown(bot);
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
    return this.tryPlaceAt(bot, tx, ty, tz, method);
  }

  /**
   * Su / powder snow kovası MLG.
   * Kritik: suyu havaya koyamazsın — raycast katı bloğa değmeli (reach ~4.5).
   * Çok yüksekte activateItem sessizce başarısız olur.
   */
  private async placeBucketMlg(bot: Bot, item: Item, method: FallMethod): Promise<boolean> {
    try {
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
    } catch {
      return false;
    }

    const hadWaterBucket = () =>
      bot.heldItem?.name === "water_bucket" ||
      bot.heldItem?.name === "powder_snow_bucket" ||
      bot.inventory.items().some((i) => i.name === item.name);

    for (let attempt = 0; attempt < 16; attempt++) {
      if (!bot.entity || this.instance.status !== "online") return false;
      if (bot.entity.onGround) return isInLiquid(bot) || hasSoftNearFeet(bot);
      if (isInLiquid(bot) || (method === "powder_snow" && hasPowderSnowNear(bot))) {
        const p = bot.entity.position;
        this.placedWaterPos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
        return true;
      }

      // kova bitti mi = yerleşti
      if (!hadWaterBucket() && bot.inventory.items().some((i) => i.name === "bucket")) {
        const p = bot.entity.position;
        this.placedWaterPos = { x: Math.floor(p.x), y: Math.floor(p.y - 0.5), z: Math.floor(p.z) };
        return true;
      }

      const land = findLandingBelow(bot);
      const feetY = bot.entity.position.y;
      const rem = land ? feetY - land.standY : 99;

      // hâlâ reach dışı — sadece bak + bekle
      if (rem > BLOCK_REACH + 0.15) {
        await lookDown(bot);
        await sleep(35);
        continue;
      }

      const bx = Math.floor(bot.entity.position.x);
      const bz = Math.floor(bot.entity.position.z);
      // katı bloğun üst yüzeyi
      const solidY = land ? Math.floor(land.standY) - 1 : Math.floor(feetY - rem) - 1;
      const solid = bot.blockAt(v3(bx, solidY, bz));
      const above = bot.blockAt(v3(bx, solidY + 1, bz));

      // zaten su var
      if (above && (above.name.includes("water") || above.name === "powder_snow")) {
        this.placedWaterPos = { x: bx, y: solidY + 1, z: bz };
        return true;
      }

      // 1) katı bloğun tepe merkezine bak (en güvenilir)
      if (solid && !isAirName(solid.name) && !solid.name.includes("water")) {
        try {
          await bot.lookAt(solid.position.offset(0.5, 0.98, 0.5), true);
        } catch {
          await lookDown(bot);
        }
      } else {
        await lookDown(bot);
      }

      // el kontrol
      if (bot.heldItem?.name !== item.name) {
        const again = bot.inventory.items().find((i) => i.name === item.name);
        if (again) {
          try {
            await bot.equip(again, "hand");
          } catch {
            return false;
          }
        } else return false;
      }

      // 2) activateItem (ana yol)
      try {
        bot.activateItem(false);
      } catch {
        try {
          await bot.activateItem();
        } catch {
          /* */
        }
      }
      await sleep(40);
      try {
        bot.deactivateItem();
      } catch {
        /* */
      }

      // 3) activateBlock — bazı sürümlerde kova için daha iyi
      if (solid && hadWaterBucket()) {
        try {
          await bot.activateBlock(solid);
        } catch {
          /* */
        }
        await sleep(30);
      }

      // 4) modern use_item paketi (1.19+)
      if (hadWaterBucket()) {
        tryUseItemPacket(bot);
        await sleep(30);
      }

      // doğrula
      if (isInLiquid(bot) || hasWaterNear(bot, bx, Math.floor(feetY), bz) || hasPowderSnowNear(bot)) {
        this.placedWaterPos = { x: bx, y: solidY + 1, z: bz };
        return true;
      }
      if (!hadWaterBucket()) {
        this.placedWaterPos = { x: bx, y: solidY + 1, z: bz };
        return true;
      }

      await sleep(40);
    }

    return isInLiquid(bot) || hasSoftNearFeet(bot);
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
      if (nearbyBoat(bot)) return true;
      await sleep(40);
    }
    return nearbyBoat(bot);
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

  private async tryPickupWater(bot: Bot) {
    if (!this.placedWaterPos) return;
    const bucket = bot.inventory.items().find((i) => i.name === "bucket");
    if (!bucket) {
      this.placedWaterPos = null;
      return;
    }
    try {
      const pos = this.placedWaterPos;
      for (const dy of [0, -1, 1, 2, -2]) {
        for (const dx of [0, 1, -1]) {
          for (const dz of [0, 1, -1]) {
            const block = bot.blockAt(v3(pos.x + dx, pos.y + dy, pos.z + dz));
            if (block && (block.name === "water" || block.name.includes("water"))) {
              await bot.equip(bucket, "hand");
              await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
              bot.activateItem(false);
              await sleep(80);
              try {
                bot.deactivateItem();
              } catch {
                /* */
              }
              this.placedWaterPos = null;
              return;
            }
          }
        }
      }
    } catch {
      /* */
    }
    this.placedWaterPos = null;
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
    if (isAirName(n)) continue;
    if (n.includes("sign") || n === "torch" || n.includes("button") || n.includes("pressure_plate") || n.includes("rail")) {
      continue;
    }

    if (SOFT_LANDING.has(n) || n.includes("water") || n.endsWith("_carpet")) {
      return { standY: y + (n.includes("water") || n === "bubble_column" ? 0 : 1), soft: true, name: n };
    }
    // solid top = y+1
    return { standY: y + 1, soft: false, name: n };
  }
  return null;
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

async function lookDown(bot: Bot) {
  try {
    // tam -90 bazen raycast kaybeder; hafif offset
    await bot.look(bot.entity.yaw, -1.45, true);
  } catch {
    try {
      await bot.lookAt(bot.entity.position.offset(0, -3, 0), true);
    } catch {
      /* */
    }
  }
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

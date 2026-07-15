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
  /** Yere bu kadar blok kala MLG yerleştir (su/tekne) */
  mlgTriggerBlocks: number;
  /** Sadece tehlikeli/ölümcül düşüşte müdahale */
  onlyWhenDangerous: boolean;
}

export const DEFAULT_FALL_GUARD: FallGuardConfig = {
  enabled: true,
  minDamageHp: 4,
  lethalHealthMargin: 2,
  mlgTriggerBlocks: 3.2,
  onlyWhenDangerous: true
};

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

/** Yumuşak iniş / hasarsız yüzeyler (üzerine inince fall damage yok veya çok az) */
const SOFT_LANDING = new Set([
  "water",
  "bubble_column",
  "lava", // hasar farklı ama düşüş hasarı yok
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
    this.timer = setInterval(() => void this.tick(), 50);
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

    // creative / spectator / elytra glide / slow falling → müdahale yok
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
    const falling = vy < -0.35 || metaFall > 1.5;
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
    // zaten yumuşak yüzeye iniyorsa (su/hay/slime…) MLG gereksiz
    if (groundInfo?.soft) {
      const remSoft = Math.max(0, feetY - groundInfo.standY);
      if (remSoft < 8) {
        this.state = {
          active: false,
          falling: true,
          method: null,
          fallDistance: round1(Math.max(metaFall, this.fallPeakY - groundInfo.standY)),
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

    const remaining =
      groundInfo != null ? Math.max(0, feetY - groundInfo.standY - 0.05) : 64;
    const fromPeak =
      groundInfo != null && this.fallPeakY != null
        ? Math.max(0, this.fallPeakY - groundInfo.standY)
        : remaining;
    const bestFall = Math.max(metaFall > 0.5 ? metaFall + Math.max(0, remaining - 0.5) : 0, fromPeak);

    const { feather, protection } = armorFallEnchants(bot);
    const predictedDamage = fallDamageHp(bestFall, feather, protection);
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
    if (Date.now() - this.lastMlgAt < 400) return;

    const method = pickBestMethod(options, remaining, lethal, predictedDamage);
    if (method === "none") {
      this.state.lastAction = lethal ? "kurtarma yok — ölümcül düşüş!" : "kurtarma malzemesi yok";
      this.emit();
      if (lethal && Date.now() - this.lastWarnAt > 3000) {
        this.lastWarnAt = Date.now();
        this.log().warn("Ölümcül düşüş — MLG malzemesi yok", `~${predictedDamage} HP · ${bestFall.toFixed(1)} blok`);
      }
      return;
    }

    const trigger =
      method === "water" || method === "boat" || method === "powder_snow"
        ? remaining <= cfg.mlgTriggerBlocks && remaining > 0.15
        : remaining <= Math.max(cfg.mlgTriggerBlocks + 2, 6) && remaining > 0.15;

    if (!trigger && remaining > cfg.mlgTriggerBlocks + 4) {
      if (!this.busy) void this.preEquip(bot, method);
      this.state.method = method;
      this.state.lastAction = `hazırlık: ${method} (${remaining.toFixed(1)}m)`;
      this.emit();
      return;
    }

    if (!trigger) {
      this.emit();
      return;
    }

    this.busy = true;
    this.state.active = true;
    this.state.method = method;
    this.state.lastAction = `MLG: ${method}`;
    this.emit(true);
    this.log().info(
      `Düşüş kurtarma: ${method}`,
      `kalan ${remaining.toFixed(1)} · hasar≈${predictedDamage} HP · düşüş≈${bestFall.toFixed(1)}${lethal ? " ÖLÜMCÜL" : ""}`
    );

    try {
      try {
        (bot as { pathfinder?: { setGoal: (g: null) => void } }).pathfinder?.setGoal(null);
      } catch {
        /* */
      }
      await this.executeMethod(bot, method, remaining);
      this.lastMlgAt = Date.now();
      this.state.lastAction = `uygulandı: ${method}`;
    } catch (e) {
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
    } catch {
      /* */
    }
  }

  private async executeMethod(bot: Bot, method: FallMethod, remaining: number) {
    const banned = this.instance.config.inventory.bannedItems;
    const item = findItemForMethod(bot, method, banned);
    if (!item) throw new Error(`${method} eşyası yok`);

    await lookDown(bot);

    if (method === "water" || method === "powder_snow") {
      await bot.equip(item, "hand");
      await sleep(30);
      await lookDown(bot);
      // right-click place
      await bot.activateItem();
      await sleep(50);
      try {
        bot.deactivateItem();
      } catch {
        /* */
      }
      const p = bot.entity.position;
      this.placedWaterPos = { x: Math.floor(p.x), y: Math.floor(p.y - 1), z: Math.floor(p.z) };
      return;
    }

    if (method === "boat") {
      await bot.equip(item, "hand");
      await sleep(30);
      await lookDown(bot);
      try {
        await bot.activateItem();
        await sleep(40);
        bot.deactivateItem();
      } catch {
        /* */
      }
      return;
    }

    await bot.equip(item, "hand");
    await sleep(20);
    const feet = bot.entity.position;
    const tx = Math.floor(feet.x);
    // yere yakın yastık: remaining'e göre 1–2 blok alt
    const ty = Math.floor(feet.y - Math.min(2, Math.max(1, Math.ceil(remaining * 0.5))));
    const tz = Math.floor(feet.z);
    await this.tryPlaceAt(bot, tx, ty, tz, method);
  }

  private async tryPlaceAt(bot: Bot, x: number, y: number, z: number, method: FallMethod) {
    const existing = bot.blockAt(v3(x, y, z));
    if (existing && existing.name !== "air" && existing.name !== "cave_air") {
      if (method === "ladder") await this.placeLadderOnNearestWall(bot);
      return;
    }

    const faces: [number, number, number][] = [
      [0, -1, 0],
      [0, 1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1]
    ];
    for (const [fx, fy, fz] of faces) {
      const refPos = v3(x + fx, y + fy, z + fz);
      const ref = bot.blockAt(refPos);
      if (!ref || ref.name === "air" || ref.name === "cave_air" || ref.name === "water" || ref.name === "lava") continue;
      try {
        await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(ref, v3(-fx, -fy, -fz));
        return;
      } catch {
        continue;
      }
    }
    if (method === "ladder") await this.placeLadderOnNearestWall(bot);
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
      if (!wall || wall.name === "air" || wall.name === "cave_air") continue;
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
      // su kaynağı ayak altında veya 1 altta
      for (const dy of [0, -1, 1]) {
        const block = bot.blockAt(v3(pos.x, pos.y + dy, pos.z));
        if (block && (block.name === "water" || block.name.includes("water"))) {
          await bot.equip(bucket, "hand");
          await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
          await bot.activateItem();
          await sleep(80);
          try {
            bot.deactivateItem();
          } catch {
            /* */
          }
          break;
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
 * Fall damage = max(0, fallDistance − 3) HP (half-hearts).
 * Feather Falling: wiki (12 × level)% azaltma, max %48 (FF IV).
 * Protection: kabaca %4 × seviye (tüm parçalar toplanır), FF ile birlikte cap %80.
 * @see https://minecraft.wiki/w/Damage#Fall_damage
 * @see https://minecraft.wiki/w/Feather_Falling
 */
export function fallDamageHp(fallDistance: number, featherFallingLevel = 0, protectionLevel = 0): number {
  if (fallDistance <= 3) return 0;
  let dmg = Math.max(0, fallDistance - 3);
  // wiki genelde tam blok sayımı; kesirli mesafede floor benzeri
  dmg = Math.max(0, Math.floor(fallDistance) - 3);
  const ffReduce = Math.min(0.48, Math.max(0, featherFallingLevel) * 0.12);
  const protReduce = Math.min(0.8, Math.max(0, protectionLevel) * 0.04);
  const totalReduce = Math.min(0.8, ffReduce + protReduce);
  dmg = Math.floor(dmg * (1 - totalReduce));
  return Math.max(0, dmg);
}

function shouldIgnoreFall(bot: Bot): boolean {
  try {
    const ent = bot.entity as unknown as { elytraFlying?: boolean };
    if (ent.elytraFlying) return true;
    const gm = (bot as unknown as { game?: { gameMode?: string } }).game?.gameMode;
    if (gm === "creative" || gm === "spectator") return true;

    // mineflayer: entity.effects is Effect[] | object depending on version
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
    const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    if (b && (b.name === "water" || b.name.includes("water") || b.name === "lava")) return true;
  } catch {
    /* */
  }
  return false;
}

function armorFallEnchants(bot: Bot): { feather: number; protection: number } {
  let feather = 0;
  let protection = 0;
  try {
    // armor slots in inventory window: 5 helmet, 6 chest, 7 legs, 8 boots
    const slots = [5, 6, 7, 8]
      .map((i) => bot.inventory.slots[i])
      .filter(Boolean) as Item[];
    // also held? no
    for (const it of slots) {
      const list = getEnchants(it);
      for (const e of list) {
        const n = e.name.toLowerCase();
        if (n.includes("feather_falling") || n.includes("featherfalling") || n === "feather_falling") {
          feather = Math.max(feather, e.lvl);
        }
        if (n === "protection" || n.endsWith(".protection") || n.includes("protection") && !n.includes("fire") && !n.includes("blast") && !n.includes("projectile")) {
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
    nbt?: { value?: { Enchantments?: { value?: { value?: Array<{ name?: { value?: string }; id?: { value?: string }; lvl?: { value?: number } }> } } } };
  };
  if (Array.isArray(any.enchants) && any.enchants.length) {
    return any.enchants.map((e) => ({ name: String(e.name), lvl: Number(e.lvl) || 1 }));
  }
  // raw nbt fallback
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
  const x = Math.floor(pos.x);
  const z = Math.floor(pos.z);
  const startY = Math.floor(pos.y);
  const minY = Math.max(-64, startY - 80);
  for (let y = startY; y >= minY; y--) {
    const b = bot.blockAt(v3(x, y, z));
    if (!b) continue;
    const n = b.name.replace(/^minecraft:/, "");
    if (n === "air" || n === "cave_air" || n === "void_air" || n === "light") continue;
    if (n.includes("sign") || n === "torch" || n.includes("button") || n.includes("pressure_plate") || n.includes("rail")) continue;

    if (SOFT_LANDING.has(n) || n.includes("water") || n.endsWith("_carpet")) {
      return { standY: y + (n.includes("water") ? 0 : 1), soft: true, name: n };
    }
    // solid
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
  predictedDamage: number
): FallMethod {
  if (!options.length) return "none";
  const score: Record<FallMethod, number> = {
    water: 100,
    powder_snow: 95,
    boat: 90,
    hay: 75,
    slime: 70,
    cobweb: 60,
    ladder: 55,
    scaffolding: 50,
    none: 0
  };
  if (!lethal && predictedDamage < 8) {
    score.hay += 10;
    score.slime += 5;
  }
  if (remaining < 1.2) {
    score.boat += 8;
    score.hay += 5;
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
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
  } catch {
    try {
      await bot.lookAt(bot.entity.position.offset(0, -2, 0), true);
    } catch {
      /* */
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

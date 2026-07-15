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
  /** Sadece ölümcül düşüşte mi yoksa her tehlikeli düşüşte mi */
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

/**
 * Yüksekten düşerken hasar almamak / ölmemek için MLG ve yumuşak iniş.
 * Pathfinder/görevlerden bağımsız, tick bazlı (SURVIVAL önceliği — gerçek zaman).
 *
 * Yöntemler (envanter + durum):
 *  - water_bucket MLG
 *  - tekne MLG
 *  - saman (hay) yastık
 *  - slime / cobweb / merdiven / scaffolding / powder snow
 */
export class FallGuardService {
  private bot: Bot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastMlgAt = 0;
  private lastEmitAt = 0;
  private lastWarnAt = 0;
  /** Düşüş başlangıç yüksekliği (fallDistance metadata yoksa yedek) */
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
    // düşerken socket spam olmasın (max ~5 Hz); önemli geçişlerde force
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

    // su aldıktan sonra kovayı doldur / suyu geri al
    if (bot.entity.onGround || (bot.entity as { isInWater?: boolean }).isInWater) {
      if (this.placedWaterPos) {
        void this.tryPickupWater(bot);
      }
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

    // zirve yüksekliği: düşüş başında veya daha yükseğe çıktıysa güncelle
    if (this.fallPeakY == null || feetY > this.fallPeakY) {
      this.fallPeakY = feetY;
    }

    const ground = findGroundY(bot);
    const remaining = ground != null ? Math.max(0, feetY - ground - 0.05) : 64;
    // meta fallDistance (+ kalan) veya peak→ground (metadata yoksa)
    const fromPeak = ground != null && this.fallPeakY != null ? Math.max(0, this.fallPeakY - ground) : remaining;
    const bestFall = Math.max(metaFall > 0.5 ? metaFall + Math.max(0, remaining - 0.5) : 0, fromPeak);

    const ff = featherFallingLevel(bot);
    const predictedDamage = fallDamageHp(bestFall, ff);
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

    // düşük hasar — izle
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

    // zamanlama: yere yaklaşınca yerleştir; hay/slime için biraz daha erken hazırlık
    const method = pickBestMethod(options, remaining, lethal, predictedDamage);
    if (method === "none") {
      this.state.lastAction = lethal ? "kurtarma yok — ölümcül düşüş!" : "kurtarma malzemesi yok";
      this.emit();
      // log spam önle: en fazla 3 sn'de bir
      if (lethal && Date.now() - this.lastWarnAt > 3000) {
        this.lastWarnAt = Date.now();
        this.log().warn("Ölümcül düşüş — MLG malzemesi yok", `~${predictedDamage} HP · ${bestFall.toFixed(1)} blok`);
      }
      return;
    }

    // su/tekne: trigger mesafesinde; hay/slime: remaining < 8'de hazırlık yerleştir
    const trigger =
      method === "water" || method === "boat" || method === "powder_snow"
        ? remaining <= cfg.mlgTriggerBlocks && remaining > 0.15
        : remaining <= Math.max(cfg.mlgTriggerBlocks + 2, 6) && remaining > 0.15;

    if (!trigger && remaining > cfg.mlgTriggerBlocks + 4) {
      // henüz erken — sadece hazırlan: eşyayı ele al
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
      // pathfinder'ı kes — bakış bozulmasın
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

    // aşağı bak
    await lookDown(bot);

    if (method === "water" || method === "powder_snow") {
      await bot.equip(item, "hand");
      await sleep(30);
      await lookDown(bot);
      bot.activateItem(false);
      await sleep(50);
      // su kaynağı tahmini ayak altı
      const p = bot.entity.position;
      this.placedWaterPos = { x: Math.floor(p.x), y: Math.floor(p.y - 1), z: Math.floor(p.z) };
      return;
    }

    if (method === "boat") {
      await bot.equip(item, "hand");
      await sleep(30);
      await lookDown(bot);
      // tekne: activateItem veya place — sürüme göre activate
      try {
        bot.activateItem(false);
      } catch {
        /* */
      }
      return;
    }

    // blok yerleştirme (hay, slime, cobweb, ladder, scaffolding)
    await bot.equip(item, "hand");
    await sleep(20);
    const feet = bot.entity.position;
    const tx = Math.floor(feet.x);
    const ty = Math.floor(feet.y - Math.min(2, Math.max(1, Math.floor(remaining))));
    const tz = Math.floor(feet.z);
    await this.tryPlaceAt(bot, tx, ty, tz, method);
  }

  private async tryPlaceAt(bot: Bot, x: number, y: number, z: number, method: FallMethod) {
    const target = v3(x, y, z);
    const existing = bot.blockAt(target);
    if (existing && existing.name !== "air" && existing.name !== "cave_air") {
      // zaten dolu — yanına / altına dene
      if (method === "ladder") {
        await this.placeLadderOnNearestWall(bot);
      }
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
    // referans yok — merdiven için duvar ara
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
        // ladder on face toward player = opposite of wall offset from player... place against wall
        await bot.placeBlock(wall, v3(-dx, 0, -dz));
        // merdivene yapış
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
      const block = bot.blockAt(v3(pos.x, pos.y, pos.z));
      // water still / flowing
      if (block && (block.name === "water" || block.name.includes("water"))) {
        await bot.equip(bucket, "hand");
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        bot.activateItem(false);
        await sleep(100);
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

/** Minecraft: 3 bloktan sonraki her blok ≈ 1 HP (yarım kalp); Feather Falling azaltır */
export function fallDamageHp(fallDistance: number, featherFallingLevel = 0): number {
  if (fallDistance <= 3) return 0;
  let dmg = Math.max(0, Math.floor(fallDistance) - 3);
  if (featherFallingLevel > 0) {
    // EPF: FF level * 3, max 20 EPF → damage *= (1 - min(20,epf)/25)
    const epf = Math.min(20, featherFallingLevel * 3);
    dmg = Math.floor(dmg * (1 - epf / 25));
  }
  return Math.max(0, dmg);
}

function featherFallingLevel(bot: Bot): number {
  try {
    const boots = bot.inventory.slots[8] ?? null; // armor boots often slot 8 in window
    // also check equipment
    const eq = (bot as unknown as { entity?: { equipment?: (Item | null)[] } }).entity?.equipment;
    const candidates = [boots, eq?.[2], eq?.[5]].filter(Boolean) as Item[];
    for (const it of candidates) {
      const ench = (it as unknown as { enchants?: Array<{ name: string; lvl: number }> }).enchants
        ?? (it as unknown as { nbt?: unknown });
      if (Array.isArray((it as unknown as { enchants?: unknown }).enchants)) {
        for (const e of (it as unknown as { enchants: Array<{ name: string; lvl: number }> }).enchants) {
          if (String(e.name).includes("feather_falling") || String(e.name).includes("featherFalling")) {
            return e.lvl ?? 1;
          }
        }
      }
      // mineflayer enchantments helper
      const anyIt = it as unknown as { enchants?: Array<{ name: string; lvl: number }> };
      if (anyIt.enchants) {
        for (const e of anyIt.enchants) {
          if (/feather/i.test(e.name)) return e.lvl ?? 1;
        }
      }
    }
  } catch {
    /* */
  }
  return 0;
}

function findGroundY(bot: Bot): number | null {
  const pos = bot.entity.position;
  const x = Math.floor(pos.x);
  const z = Math.floor(pos.z);
  const startY = Math.floor(pos.y);
  const minY = Math.max(-64, startY - 80);
  for (let y = startY; y >= minY; y--) {
    const b = bot.blockAt(v3(x, y, z));
    if (!b) continue;
    const n = b.name;
    if (n === "air" || n === "cave_air" || n === "void_air" || n === "water" || n === "lava" || n === "light") continue;
    // non-solid-ish
    if (n.includes("sign") || n === "torch" || n.includes("button") || n.includes("pressure_plate")) continue;
    return y + 1; // feet stand on top of solid
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
  // skor: ölümcülde su/tekne en iyi; hay hasarı %80 azaltır
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
  // kısa mesafede hay yeterli olabilir
  if (!lethal && predictedDamage < 8) {
    score.hay += 10;
    score.slime += 5;
  }
  // çok yakın yere su timing zor — tekne/hay tercih
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
    // pitch = -90° (düz aşağı)
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

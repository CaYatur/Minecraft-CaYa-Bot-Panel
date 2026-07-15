import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import { ensureMovement } from "../movement";
import { v3 } from "../build/vec3util";

export interface HazardGuardConfig {
  enabled: boolean;
  /** Ateş/lav fleeing yarıçapı */
  escapeRadius: number;
  /** Su bulunca söndür / exit lava */
  seekWater: boolean;
  /** Inventory has insufficient water_bucket varsa acil dök (ateş üstünde) */
  useWaterBucket: boolean;
}

export const DEFAULT_HAZARD_GUARD: HazardGuardConfig = {
  enabled: true,
  escapeRadius: 12,
  seekWater: true,
  useWaterBucket: true
};

export interface HazardGuardState {
  active: boolean;
  onFire: boolean;
  inLava: boolean;
  nearHazard: boolean;
  action: string;
}

/**
 * Ateş / lav / magma koruması (otomatik):
 * - lavdaysa çık (jump + en yakın safe blocks)
 * - on firesa suya koş veya kovayla sön
 * - altta magma/ateş varsa kaç
 */
export class HazardGuardService {
  private bot: Bot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastEscape = 0;
  private lastLog = 0;
  private lastBucket = 0;
  private state: HazardGuardState = idleState();

  constructor(private readonly instance: BotInstance) {}

  getState(): HazardGuardState {
    return { ...this.state };
  }

  private cfg(): HazardGuardConfig {
    const s = this.instance.config.survival as { hazardGuard?: Partial<HazardGuardConfig> };
    return { ...DEFAULT_HAZARD_GUARD, ...(s.hazardGuard ?? {}) };
  }

  private log() {
    return this.instance.getLogger();
  }

  attach(bot: Bot) {
    this.detach();
    this.bot = bot;
    this.timer = setInterval(() => void this.tick(), 120);
    setTimeout(() => void this.tick(), 300);
    setTimeout(() => void this.tick(), 1000);
  }

  detach() {
    const bot = this.bot;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (bot) {
      try {
        bot.setControlState("jump", false);
        bot.setControlState("forward", false);
        bot.setControlState("sprint", false);
        bot.pathfinder?.setGoal(null);
      } catch {
        /* */
      }
    }
    this.bot = null;
    this.busy = false;
    this.state = idleState();
  }

  private async tick() {
    const bot = this.bot;
    if (!bot || this.instance.status !== "online" || !bot.entity) return;
    const cfg = this.cfg();
    if (!cfg.enabled) {
      if (this.state.active) this.state = idleState();
      return;
    }

    const onFire = isOnFire(bot);
    const inLava = isInLava(bot);
    const feetHazard = isFeetOnHazard(bot);
    const danger = onFire || inLava || feetHazard;

    this.state.onFire = onFire;
    this.state.inLava = inLava;
    this.state.nearHazard = feetHazard;
    this.state.active = danger;

    if (!danger) {
      if (this.state.action && this.state.action !== "safe") {
        this.state.action = "safe";
      }
      return;
    }

    // 1) Lav forde — hemen yukarı/yan kaç
    if (inLava) {
      this.state.action = "exit lava";
      try {
        bot.setControlState("jump", true);
        bot.setControlState("forward", true);
        bot.setControlState("sprint", true);
      } catch {
        /* */
      }
      if (Date.now() - this.lastLog > 3000) {
        this.lastLog = Date.now();
        this.log().warn("Lava guard", "in lava — exiting");
      }
    }

    // 2) Water bucket ile sön (ateş + kova, lavda da dene)
    if (cfg.useWaterBucket && (onFire || inLava) && Date.now() - this.lastBucket > 2500) {
      const used = await this.tryWaterBucket(bot);
      if (used) {
        this.lastBucket = Date.now();
        this.state.action = "extinguish with water bucket";
        this.log().info("Hazard guard", "water_bucket used");
      }
    }

    // 3) Path ile safe / su noktası
    if (!this.busy && Date.now() - this.lastEscape > 1800) {
      this.lastEscape = Date.now();
      void this.escapeToSafety(bot, cfg, onFire, inLava);
    }

    // exit lavatıysa kontrolleri drop (pathfinder devralır)
    if (!inLava) {
      try {
        // pathfinder forward kullanır; jump drop
        if (!isInWaterBlock(bot)) bot.setControlState("jump", false);
      } catch {
        /* */
      }
    }
  }

  private async tryWaterBucket(bot: Bot): Promise<boolean> {
    const banned = this.instance.config.inventory.bannedItems;
    if (banned.includes("water_bucket")) return false;
    const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
    if (!bucket) return false;
    try {
      await bot.equip(bucket, "hand");
      // ayak altına / önüne dök
      const p = bot.entity.position;
      await bot.look(bot.entity.yaw, 0.9, false); // slightly down
      await sleep(40);
      await bot.activateItem();
      await sleep(60);
      try {
        bot.deactivateItem();
      } catch {
        /* */
      }
      // suyu geri al (sönme sonrası) — kısa bekle
      await sleep(400);
      const empty = bot.inventory.items().find((i) => i.name === "bucket");
      if (empty) {
        try {
          await bot.equip(empty, "hand");
          const water = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
          if (water && water.name.includes("water")) {
            await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), false);
            await bot.activateItem();
            await sleep(50);
            bot.deactivateItem();
          }
        } catch {
          /* */
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private async escapeToSafety(bot: Bot, cfg: HazardGuardConfig, onFire: boolean, inLava: boolean) {
    if (this.busy) return;
    this.busy = true;
    try {
      let target: { x: number; y: number; z: number } | null = null;
      if (cfg.seekWater && (onFire || inLava)) {
        target = findNearbyWaterOrSafe(bot, cfg.escapeRadius, true);
      }
      if (!target) {
        target = findNearbyWaterOrSafe(bot, cfg.escapeRadius, false);
      }
      if (!target) {
        // rastgele geri kaç — hazard'dan uzak vektör
        const away = fleeVector(bot);
        target = {
          x: Math.floor(bot.entity.position.x + away.x * 6),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z + away.z * 6)
        };
        this.state.action = "rastgele fleeing";
      } else {
        this.state.action = onFire ? "run to water/safe" : "move away from lava";
      }

      ensureMovement(this.instance, { allowSprintNow: true });
      bot.pathfinder.setGoal(new goals.GoalNear(target.x + 0.5, target.y, target.z + 0.5, 1));

      const t0 = Date.now();
      while (Date.now() - t0 < 12_000 && this.bot === bot && this.instance.status === "online") {
        if (!isOnFire(bot) && !isInLava(bot) && !isFeetOnHazard(bot)) break;
        if (isInLava(bot)) {
          bot.setControlState("jump", true);
          bot.setControlState("forward", true);
        }
        await sleep(120);
      }
    } catch (e) {
      this.log().debug("Hazard flee", e instanceof Error ? e.message : String(e));
    } finally {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
      try {
        bot.setControlState("jump", false);
        bot.setControlState("forward", false);
        bot.setControlState("sprint", false);
      } catch {
        /* */
      }
      this.busy = false;
    }
  }
}

function idleState(): HazardGuardState {
  return { active: false, onFire: false, inLava: false, nearHazard: false, action: "" };
}

function isOnFire(bot: Bot): boolean {
  try {
    if ((bot.entity as { onFire?: boolean }).onFire) return true;
    // prismarine-entity: fireTicks or burning
    const anyE = bot.entity as unknown as { fireTicks?: number; burning?: boolean };
    if (anyE.burning) return true;
    if (typeof anyE.fireTicks === "number" && anyE.fireTicks > 0) return true;
  } catch {
    /* */
  }
  return false;
}

function isInLava(bot: Bot): boolean {
  try {
    if ((bot.entity as { isInLava?: boolean }).isInLava) return true;
    const p = bot.entity.position;
    for (const oy of [0, 0.5, 1]) {
      const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y + oy), Math.floor(p.z)));
      if (b && (b.name === "lava" || b.name.includes("lava"))) return true;
    }
  } catch {
    /* */
  }
  return false;
}

function isFeetOnHazard(bot: Bot): boolean {
  try {
    const p = bot.entity.position;
    const below = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y - 0.2), Math.floor(p.z)));
    const at = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    for (const b of [below, at]) {
      if (!b) continue;
      const n = b.name;
      if (n === "fire" || n === "soul_fire" || n === "lava" || n.includes("lava") || n === "magma_block" || n === "campfire" || n === "soul_campfire") {
        return true;
      }
    }
  } catch {
    /* */
  }
  return false;
}

function isInWaterBlock(bot: Bot): boolean {
  try {
    if ((bot.entity as { isInWater?: boolean }).isInWater) return true;
    const p = bot.entity.position;
    const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    return Boolean(b && (b.name === "water" || b.name.includes("water")));
  } catch {
    return false;
  }
}

function isHazardBlock(name: string): boolean {
  return (
    name === "lava" ||
    name.includes("lava") ||
    name === "fire" ||
    name === "soul_fire" ||
    name === "magma_block" ||
    name === "campfire" ||
    name === "soul_campfire"
  );
}

function isSafeStand(bot: Bot, x: number, y: number, z: number): boolean {
  const ground = bot.blockAt(v3(x, y - 1, z));
  const feet = bot.blockAt(v3(x, y, z));
  const head = bot.blockAt(v3(x, y + 1, z));
  if (!ground || ground.boundingBox !== "block") return false;
  if (isHazardBlock(ground.name)) return false;
  if (feet && (feet.boundingBox === "block" || isHazardBlock(feet.name))) return false;
  if (head && head.boundingBox === "block") return false;
  return true;
}

function isWaterStand(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  const above = bot.blockAt(v3(x, y + 1, z));
  if (!b) return false;
  if (!(b.name === "water" || b.name.includes("water"))) return false;
  // yüzey suyu tercih
  if (above && (above.name === "water" || above.name.includes("water"))) return false;
  return true;
}

function findNearbyWaterOrSafe(
  bot: Bot,
  radius: number,
  preferWater: boolean
): { x: number; y: number; z: number } | null {
  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  let bestWater: { x: number; y: number; z: number; d: number } | null = null;
  let bestSafe: { x: number; y: number; z: number; d: number } | null = null;

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue;
      for (let dy = -3; dy <= 4; dy++) {
        const x = bx + dx;
        const y = by + dy;
        const z = bz + dz;
        const d = dx * dx + dy * dy * 2 + dz * dz;
        if (preferWater && isWaterStand(bot, x, y, z)) {
          if (!bestWater || d < bestWater.d) bestWater = { x, y, z, d };
        }
        if (isSafeStand(bot, x, y, z)) {
          // hazard kaynağından uzaklaş — mevcut lav bloğuna gitme
          if (!bestSafe || d < bestSafe.d) bestSafe = { x, y, z, d };
        }
      }
    }
  }
  if (preferWater && bestWater) return { x: bestWater.x, y: bestWater.y, z: bestWater.z };
  if (bestSafe) return { x: bestSafe.x, y: bestSafe.y, z: bestSafe.z };
  if (bestWater) return { x: bestWater.x, y: bestWater.y, z: bestWater.z };
  return null;
}

/** Tehlike bloğundan uzaklaşma yönü */
function fleeVector(bot: Bot): { x: number; z: number } {
  const p = bot.entity.position;
  let hx = 0;
  let hz = 0;
  let n = 0;
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const b = bot.blockAt(v3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz));
        if (b && isHazardBlock(b.name)) {
          hx += dx;
          hz += dz;
          n++;
        }
      }
    }
  }
  if (n === 0) {
    // bakış yönünün tersi
    return { x: Math.sin(bot.entity.yaw), z: -Math.cos(bot.entity.yaw) };
  }
  // tehlikeden uzak = -ortalama
  let x = -hx / n;
  let z = -hz / n;
  const len = Math.sqrt(x * x + z * z) || 1;
  return { x: x / len, z: z / len };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

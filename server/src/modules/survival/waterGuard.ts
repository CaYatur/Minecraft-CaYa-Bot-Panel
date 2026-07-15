import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import { ensureMovement } from "../movement";
import { v3 } from "../build/vec3util";

export interface WaterGuardConfig {
  enabled: boolean;
  /** Oksijen bu altına inince acil yüzeye çık (0–20) */
  surfaceOxygenBelow: number;
  /** Karaya çıkmayı dene */
  seekLand: boolean;
  /** Karaya arama yarıçapı */
  landSearchRadius: number;
}

export const DEFAULT_WATER_GUARD: WaterGuardConfig = {
  enabled: true,
  surfaceOxygenBelow: 14,
  seekLand: true,
  landSearchRadius: 16
};

export interface WaterGuardState {
  active: boolean;
  inWater: boolean;
  submerged: boolean;
  oxygen: number;
  action: string;
}

/**
 * Suda doğma / boğulma koruması:
 * - su altındayken yukarı yüz (jump = swim up)
 * - oksijen düşükse öncelik yüzey
 * - mümkünse yakındaki karaya pathfinder
 * - yüzeydeyken yüzebilir, boğulmaz (nefes alıyorsa jump bırak)
 */
export class WaterGuardService {
  private bot: Bot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busyLand = false;
  private lastLandSeek = 0;
  private lastLog = 0;
  private holdingSwimUp = false;
  private state: WaterGuardState = idleState();

  constructor(private readonly instance: BotInstance) {}

  getState(): WaterGuardState {
    return { ...this.state };
  }

  private cfg(): WaterGuardConfig {
    const s = this.instance.config.survival as { waterGuard?: Partial<WaterGuardConfig> };
    return { ...DEFAULT_WATER_GUARD, ...(s.waterGuard ?? {}) };
  }

  private log() {
    return this.instance.getLogger();
  }

  attach(bot: Bot) {
    this.detach();
    this.bot = bot;
    this.timer = setInterval(() => void this.tick(), 100);
    // spawn anında hemen kontrol
    setTimeout(() => void this.tick(), 200);
    setTimeout(() => void this.tick(), 800);
  }

  detach() {
    this.releaseSwimControls();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bot = null;
    this.busyLand = false;
    this.state = idleState();
  }

  private releaseSwimControls() {
    const bot = this.bot;
    if (!bot || !this.holdingSwimUp) return;
    try {
      bot.setControlState("jump", false);
      // forward'ı sadece biz bastıysak — land pathfinder kendi yönetir; jump bırak yeter
    } catch {
      /* */
    }
    this.holdingSwimUp = false;
  }

  private async tick() {
    const bot = this.bot;
    if (!bot || this.instance.status !== "online" || !bot.entity) return;
    const cfg = this.cfg();
    if (!cfg.enabled) {
      if (this.state.active) {
        this.releaseSwimControls();
        this.state = idleState();
      }
      return;
    }

    const oxygen = readOxygen(bot);
    const inWater = isInWater(bot);
    const submerged = isHeadSubmerged(bot);
    const onSurface = inWater && !submerged;
    const combatBusy = this.isCombatBusy();
    const fallBusy = this.instance.survival?.getFallGuardState?.()?.active === true;

    this.state.inWater = inWater;
    this.state.submerged = submerged;
    this.state.oxygen = oxygen;

    // karada ve nefes tamam → idle
    if (!inWater) {
      if (this.state.active || this.holdingSwimUp) {
        this.releaseSwimControls();
        this.state = idleState();
        this.state.action = "karada";
      }
      return;
    }

    this.state.active = true;
    const needAir = submerged || oxygen < cfg.surfaceOxygenBelow;
    // dövüş/MLG sırasında sadece boğulma engelle; karaya path + jump spam yok
    const yieldToCombat = combatBusy && oxygen >= 8 && !submerged;

    if (yieldToCombat) {
      if (this.holdingSwimUp) this.releaseSwimControls();
      this.state.action = "dövüş öncelikli (su beklemede)";
      // devam eden kara path'i kes
      if (this.busyLand) {
        try {
          bot.pathfinder?.setGoal(null);
        } catch {
          /* */
        }
      }
      return;
    }

    // 1) Yukarı yüz — boğulmamak için
    if (needAir) {
      try {
        await bot.look(bot.entity.yaw, -0.6, false);
      } catch {
        /* */
      }
      try {
        bot.setControlState("jump", true);
        this.holdingSwimUp = true;
      } catch {
        /* */
      }
      this.state.action = oxygen < 8 ? "acil yüzeye çık" : "yukarı yüz";
      if (Date.now() - this.lastLog > 4000) {
        this.lastLog = Date.now();
        this.log().info("Su koruması", `oksijen=${oxygen} · ${this.state.action}`);
      }
    } else if (onSurface) {
      if (this.holdingSwimUp) {
        try {
          bot.setControlState("jump", false);
        } catch {
          /* */
        }
        this.holdingSwimUp = false;
      }
      this.state.action = "yüzeyde (güvenli)";
    }

    // 2) Karaya çık — dövüş/MLG yokken ve oksijen/derinlik gerekince
    if (cfg.seekLand && !this.busyLand && Date.now() - this.lastLandSeek > 2500) {
      if (combatBusy || fallBusy) return;
      const hazardBusy = this.instance.survival?.hazardGuard?.getState?.()?.active;
      if (hazardBusy) return;
      const depth = waterDepthBelow(bot);
      // sığ suda (depth&lt;2) ve oksijen iyi + yüzeyde → karaya zorlama (drowned dövüşünü bozma)
      if (onSurface && oxygen >= cfg.surfaceOxygenBelow && depth < 2 && !submerged) {
        return;
      }
      if (depth >= 2 || oxygen < cfg.surfaceOxygenBelow || submerged) {
        this.lastLandSeek = Date.now();
        void this.trySeekLand(bot, cfg);
      }
    }
  }

  /** Dövüş / savunma / kaçış aktif mi? */
  private isCombatBusy(): boolean {
    try {
      const r = this.instance.combat.getRuntime();
      if (r.fighting || r.mode === "defending" || r.mode === "attacking" || r.mode === "fleeing") return true;
    } catch {
      /* */
    }
    const cur = this.instance.tasks.currentSummary;
    if (cur && ["defend", "attack", "flee", "clear-mobs"].includes(cur.type)) return true;
    const q = this.instance.tasks.queueSummaries ?? [];
    if (q.some((t) => ["defend", "attack", "flee"].includes(t.type))) return true;
    return false;
  }

  private async trySeekLand(bot: Bot, cfg: WaterGuardConfig) {
    if (this.busyLand) return;
    if (this.isCombatBusy()) return;

    const land = findNearbyLand(bot, cfg.landSearchRadius);
    if (!land) {
      this.state.action = this.state.action || "kara yok — yüzmeye devam";
      return;
    }

    this.busyLand = true;
    this.state.action = `karaya → ${land.x},${land.y},${land.z}`;
    this.log().info("Su koruması: karaya çıkılıyor", `${land.x} ${land.y} ${land.z}`);

    try {
      const cur = this.instance.tasks.currentSummary;
      const oxygen = readOxygen(bot);
      // dövüş görevi / herhangi USER+ görev varken ve oksijen idare ederse path açma
      if (this.isCombatBusy()) {
        this.busyLand = false;
        return;
      }
      if (cur && !["water-escape", "flee"].includes(cur.type) && oxygen > 8) {
        this.busyLand = false;
        return;
      }

      ensureMovement(this.instance, { allowSprintNow: false });
      bot.pathfinder.setGoal(new goals.GoalNear(land.x + 0.5, land.y, land.z + 0.5, 1));

      const t0 = Date.now();
      while (Date.now() - t0 < 20_000 && this.instance.status === "online" && this.bot === bot) {
        // dövüş başladı → path bırak, silaha alan aç
        if (this.isCombatBusy() && readOxygen(bot) >= 8) {
          this.state.action = "karaya iptal — dövüş";
          break;
        }
        if (!isInWater(bot) && bot.entity.onGround) break;
        if (isHeadSubmerged(bot) || readOxygen(bot) < cfg.surfaceOxygenBelow) {
          bot.setControlState("jump", true);
          this.holdingSwimUp = true;
          try {
            await bot.look(bot.entity.yaw, -0.5, false);
          } catch {
            /* */
          }
        }
        await sleep(150);
      }
    } catch (e) {
      this.log().debug("Karaya çıkış path", e instanceof Error ? e.message : String(e));
    } finally {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
      this.busyLand = false;
      if (!isHeadSubmerged(bot)) {
        try {
          bot.setControlState("jump", false);
        } catch {
          /* */
        }
        this.holdingSwimUp = false;
      }
    }
  }
}

function idleState(): WaterGuardState {
  return { active: false, inWater: false, submerged: false, oxygen: 20, action: "" };
}

function readOxygen(bot: Bot): number {
  const any = bot as unknown as { oxygenLevel?: number };
  if (typeof any.oxygenLevel === "number") return any.oxygenLevel;
  // metadata fallback — genelde 20 dolu
  return 20;
}

function isInWater(bot: Bot): boolean {
  try {
    if ((bot.entity as { isInWater?: boolean }).isInWater) return true;
    const p = bot.entity.position;
    const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    if (b && (b.name === "water" || b.name.includes("water") || b.name === "bubble_column")) return true;
    const b2 = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y + 0.4), Math.floor(p.z)));
    if (b2 && (b2.name === "water" || b2.name.includes("water"))) return true;
  } catch {
    /* */
  }
  return false;
}

/** Kafa suyun içinde mi (nefes alamaz) */
function isHeadSubmerged(bot: Bot): boolean {
  try {
    const eye = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
    const p = bot.entity.position;
    const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y + eye), Math.floor(p.z)));
    if (b && (b.name === "water" || b.name.includes("water") || b.name === "bubble_column")) return true;
    // oksijen düşüyorsa büyük ihtimalle batık
    if (isInWater(bot) && readOxygen(bot) < 20 && !bot.entity.onGround) {
      const above = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y + eye + 0.3), Math.floor(p.z)));
      if (above && (above.name === "water" || above.name.includes("water"))) return true;
    }
  } catch {
    /* */
  }
  return false;
}

function waterDepthBelow(bot: Bot): number {
  const p = bot.entity.position;
  const x = Math.floor(p.x);
  const z = Math.floor(p.z);
  let depth = 0;
  for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 12; y--) {
    const b = bot.blockAt(v3(x, y, z));
    if (!b) break;
    if (b.name === "water" || b.name.includes("water") || b.name === "bubble_column") depth++;
    else if (b.boundingBox === "block") break;
    else break;
  }
  return depth;
}

/** Yakında ayak basılacak kara bloğu (üstünde hava) */
function findNearbyLand(bot: Bot, radius: number): { x: number; y: number; z: number } | null {
  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  let best: { x: number; y: number; z: number; d: number } | null = null;

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue;
      for (let dy = -4; dy <= 6; dy++) {
        const x = bx + dx;
        const y = by + dy;
        const z = bz + dz;
        const ground = bot.blockAt(v3(x, y, z));
        const above = bot.blockAt(v3(x, y + 1, z));
        const above2 = bot.blockAt(v3(x, y + 2, z));
        if (!ground || ground.boundingBox !== "block") continue;
        if (ground.name.includes("water") || ground.name === "lava" || ground.name.includes("lava")) continue;
        if (above && (above.name === "water" || above.boundingBox === "block")) continue;
        if (above2 && above2.boundingBox === "block") continue;
        const d = dx * dx + dy * dy + dz * dz;
        if (!best || d < best.d) best = { x, y: y + 1, z, d };
      }
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

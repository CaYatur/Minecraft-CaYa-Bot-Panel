import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import { countItemName } from "./fallGuard";
import { v3 } from "../build/vec3util";

/**
 * Boş kova ile yakındaki su/lav kaynağı doldurma (opsiyonel).
 * MLG su geri almadan BAĞIMSIZ — kapatılsa bile MLG reclaim çalışır.
 */
export interface BucketScoopConfig {
  enabled: boolean;
  scoopWater: boolean;
  scoopLava: boolean;
  /** tarama yarıçapı (blok) */
  radius: number;
  /** denemeler arası ms */
  cooldownMs: number;
}

export const DEFAULT_BUCKET_SCOOP: BucketScoopConfig = {
  enabled: false,
  scoopWater: true,
  scoopLava: false,
  radius: 3,
  cooldownMs: 2500
};

export class BucketScoopService {
  private bot: Bot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastAt = 0;

  constructor(private readonly instance: BotInstance) {}

  private cfg(): BucketScoopConfig {
    const s = this.instance.config.survival as { bucketScoop?: Partial<BucketScoopConfig> };
    return { ...DEFAULT_BUCKET_SCOOP, ...(s.bucketScoop ?? {}) };
  }

  private log() {
    return this.instance.getLogger();
  }

  attach(bot: Bot) {
    this.detach();
    this.bot = bot;
    this.timer = setInterval(() => void this.tick(), 400);
  }

  detach() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bot = null;
    this.busy = false;
  }

  private async tick() {
    if (this.busy) return;
    const bot = this.bot;
    if (!bot || this.instance.status !== "online" || !bot.entity) return;
    const cfg = this.cfg();
    if (!cfg.enabled) return;
    if (!cfg.scoopWater && !cfg.scoopLava) return;
    if (Date.now() - this.lastAt < cfg.cooldownMs) return;

    // düşerken / dövüş kaçışında / yanıyorken uğraşma
    if (!this.isSafe(bot)) return;

    const empty = countItemName(bot, "bucket");
    if (empty < 1) return;

    // MLG geri-al kuyruğu doluysa (su) çakışma — FallGuard reclaim etsin
    try {
      const fg = this.instance.survival?.getFallGuardState?.();
      if (fg?.lastAction?.includes("geri-al") && fg.lastAction.includes("water")) {
        // yumuşak: reclaim aktifken scoop yok
        if (fg.active || fg.falling) return;
      }
    } catch {
      /* */
    }

    const target = findScoopTarget(bot, cfg);
    if (!target) return;

    this.busy = true;
    this.lastAt = Date.now();
    try {
      const beforeW = countItemName(bot, "water_bucket");
      const beforeL = countItemName(bot, "lava_bucket");
      const beforeE = countItemName(bot, "bucket");

      const bucket = bot.inventory.items().find((i) => i.name === "bucket");
      if (!bucket) return;
      await bot.equip(bucket, "hand");
      await bot.lookAt(v3(target.x + 0.5, target.y + 0.4, target.z + 0.5), true);
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
      await sleep(70);
      try {
        bot.deactivateItem();
      } catch {
        /* */
      }
      try {
        const b = bot.blockAt(v3(target.x, target.y, target.z));
        if (b) await bot.activateBlock(b);
      } catch {
        /* */
      }
      await sleep(50);

      const afterW = countItemName(bot, "water_bucket");
      const afterL = countItemName(bot, "lava_bucket");
      const afterE = countItemName(bot, "bucket");
      if (afterW > beforeW || afterL > beforeL || afterE < beforeE) {
        this.log().info(
          "Kova dolduruldu",
          `${target.kind === "lava" ? "lava" : "su"} @${target.x},${target.y},${target.z}`
        );
      }
    } catch (e) {
      this.log().debug("Kova doldurma", e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
  }

  private isSafe(bot: Bot): boolean {
    if (!bot.entity?.onGround && !(bot.entity as { isInWater?: boolean }).isInWater) {
      const vy = bot.entity.velocity?.y ?? 0;
      if (vy < -0.3) return false;
    }
    try {
      if ((bot as { onFire?: boolean }).onFire) return false;
    } catch {
      /* */
    }
    try {
      const mode = this.instance.combat?.getRuntime?.()?.mode;
      if (mode === "fleeing" || mode === "defending" || mode === "attacking") return false;
    } catch {
      /* */
    }
    const hp = bot.health ?? 20;
    if (hp <= 6) return false;
    return true;
  }
}

function findScoopTarget(
  bot: Bot,
  cfg: BucketScoopConfig
): { x: number; y: number; z: number; kind: "water" | "lava" } | null {
  if (!bot.entity) return null;
  const p = bot.entity.position;
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const cz = Math.floor(p.z);
  const r = Math.max(1, Math.min(6, cfg.radius));
  let best: { x: number; y: number; z: number; kind: "water" | "lava"; d: number } | null = null;

  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const b = bot.blockAt(v3(cx + dx, cy + dy, cz + dz));
        if (!b) continue;
        const n = b.name.replace(/^minecraft:/, "");
        let kind: "water" | "lava" | null = null;
        if (cfg.scoopWater && (n === "water" || n.includes("water") || n === "bubble_column")) kind = "water";
        if (cfg.scoopLava && (n === "lava" || n.includes("lava"))) kind = "lava";
        if (!kind) continue;
        const d = Math.hypot(dx, dy, dz);
        if (!best || d < best.d) best = { x: cx + dx, y: cy + dy, z: cz + dz, kind, d };
      }
    }
  }
  return best;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

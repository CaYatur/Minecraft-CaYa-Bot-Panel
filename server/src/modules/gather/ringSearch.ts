import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import type { ProgressFn, TaskToken } from "../../core/TaskQueue";
import { runGoto } from "../movement";

export interface RingSearchOptions {
  step?: number;
  maxRadius?: number;
  /** return true when found and search should stop */
  probe: (bot: Bot) => boolean | Promise<boolean>;
}

/**
 * Halka arama (Faz 8): merkezden dışa halkalar; her durakta probe.
 * İlerleme: "aranıyor… halka k/n"
 */
export async function ringSearch(
  instance: BotInstance,
  token: TaskToken,
  report: ProgressFn,
  opts: RingSearchOptions
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot çevrimdışı");

  const step = opts.step ?? 32;
  const maxR = opts.maxRadius ?? 256;
  const rings = Math.max(1, Math.ceil(maxR / step));
  const origin = bot.entity.position.clone();

  // önce mevcut konumda dene
  if (await opts.probe(bot)) return true;

  for (let ring = 1; ring <= rings; ring++) {
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    report({ done: ring - 1, total: rings, label: `aranıyor… halka ${ring}/${rings}` });

    const r = ring * step;
    // 8 yön + ara noktalar (16 köşe)
    const points: { x: number; z: number }[] = [];
    const n = 8 + ring * 2;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      points.push({ x: origin.x + Math.cos(ang) * r, z: origin.z + Math.sin(ang) * r });
    }

    for (const p of points) {
      if (token.cancelled) throw new Error(token.reason ?? "iptal");
      try {
        await runGoto(instance, p.x, origin.y, p.z, 3, token, () => {});
      } catch {
        continue; // unreachable sample point
      }
      if (await opts.probe(bot)) {
        report({ done: rings, total: rings, label: `bulundu (halka ${ring})` });
        return true;
      }
    }
  }

  report({ done: rings, total: rings, label: "arama tükendi" });
  return false;
}

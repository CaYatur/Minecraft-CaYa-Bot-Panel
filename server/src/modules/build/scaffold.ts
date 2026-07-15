import type { Bot } from "mineflayer";
import { v3 } from "./vec3util";

export interface ScaffoldRecord {
  x: number;
  y: number;
  z: number;
  name: string;
}

/**
 * Scaffold defteri: inşaat sırasında koyulan geçici bloklar.
 * İş bitince (veya iptalde) ters sırada kırılır.
 */
export class ScaffoldTracker {
  private stack: ScaffoldRecord[] = [];

  get count(): number {
    return this.stack.length;
  }

  get records(): readonly ScaffoldRecord[] {
    return this.stack;
  }

  record(x: number, y: number, z: number, name: string) {
    this.stack.push({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), name });
  }

  clear() {
    this.stack = [];
  }

  async cleanup(
    bot: Bot,
    token: { cancelled: boolean },
    onProgress?: (cleared: number, total: number) => void
  ): Promise<number> {
    let cleared = 0;
    const total = this.stack.length;
    const ordered = [...this.stack].sort((a, b) => b.y - a.y || b.x - a.x || b.z - a.z);

    for (const rec of ordered) {
      if (token.cancelled) break;
      const pos = v3(rec.x, rec.y, rec.z);
      const b = bot.blockAt(pos);
      if (!b || b.name === "air" || b.name === "cave_air") {
        cleared++;
        onProgress?.(cleared, total);
        continue;
      }
      const ok = b.name === rec.name || isScaffoldFamily(b.name);
      if (!ok) {
        cleared++;
        onProgress?.(cleared, total);
        continue;
      }
      try {
        if (bot.canDigBlock(b)) {
          await bot.dig(b, true);
        }
      } catch {
        /* dig fail — skip */
      }
      cleared++;
      onProgress?.(cleared, total);
      await sleep(50);
    }

    this.stack = [];
    return cleared;
  }
}

export function isScaffoldFamily(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "dirt" ||
    n === "cobblestone" ||
    n === "netherrack" ||
    n === "scaffolding" ||
    n === "oak_planks" ||
    n === "dirt_path" ||
    n === "grass_block" ||
    n === "sand" ||
    n === "gravel"
  );
}

export function pickScaffoldItem(bot: Bot, preferred: string[]): string | null {
  const items = bot.inventory.items();
  for (const name of preferred) {
    if (items.some((i) => i.name === name)) return name;
  }
  for (const i of items) {
    if (isScaffoldFamily(i.name)) return i.name;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

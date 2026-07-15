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
 * Yapı bloğu konan hücreler korunur — yanlışlıkla yapı dirt'i kırılmaz.
 */
export class ScaffoldTracker {
  private stack: ScaffoldRecord[] = [];
  /** yapı başarıyla kondu → bu hücreler asla kazılmaz */
  private protected = new Set<string>();

  get count(): number {
    return this.stack.length;
  }

  get records(): readonly ScaffoldRecord[] {
    return this.stack;
  }

  private key(x: number, y: number, z: number) {
    return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  }

  record(x: number, y: number, z: number, name: string) {
    const k = this.key(x, y, z);
    if (this.protected.has(k)) return; // yapı hücresi scaffold sayılmaz
    this.stack.push({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), name });
  }

  /** Kalıcı yapı bloğu kondu — scaffold kaydını düşür ve koru */
  protectStructure(x: number, y: number, z: number) {
    const k = this.key(x, y, z);
    this.protected.add(k);
    this.stack = this.stack.filter((r) => this.key(r.x, r.y, r.z) !== k);
  }

  clear() {
    this.stack = [];
    this.protected.clear();
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
      const k = this.key(rec.x, rec.y, rec.z);
      if (this.protected.has(k)) {
        cleared++;
        onProgress?.(cleared, total);
        continue;
      }
      const pos = v3(rec.x, rec.y, rec.z);
      const b = bot.blockAt(pos);
      if (!b || b.name === "air" || b.name === "cave_air") {
        cleared++;
        onProgress?.(cleared, total);
        continue;
      }
      // sadece scaffold tipi ve hâlâ aynı aile — yapı bloğu değil
      const ok = b.name === rec.name || isScaffoldFamily(b.name);
      if (!ok) {
        cleared++;
        onProgress?.(cleared, total);
        continue;
      }
      try {
        // bot ayak altındaysa biraz kay
        const feet = bot.entity.position;
        if (Math.floor(feet.x) === rec.x && Math.floor(feet.y) === rec.y && Math.floor(feet.z) === rec.z) {
          cleared++;
          onProgress?.(cleared, total);
          continue;
        }
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

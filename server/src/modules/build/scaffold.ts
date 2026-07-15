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
          await equipBestToolForBlock(bot, b);
          await bot.dig(b, true);
        }
      } catch {
        /* dig fail — skip */
      }
      cleared++;
      onProgress?.(cleared, total);
      await sleep(30);
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

/**
 * Kırma öncesi doğru alet: mineflayer-tool varsa o; yoksa kazma/kürek skoru.
 * (Elle taş kırma yavaşlığı / yanlış alet)
 */
export async function equipBestToolForBlock(bot: Bot, block: { name: string }): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const toolPlugin = require("mineflayer-tool").plugin as (bot: Bot) => void;
    const anyBot = bot as unknown as { tool?: { equipForBlock(b: unknown): Promise<void> } };
    if (!anyBot.tool) bot.loadPlugin(toolPlugin);
    if (anyBot.tool) {
      await anyBot.tool.equipForBlock(block);
      return;
    }
  } catch {
    /* plugin yok / fail → yedek */
  }

  const n = block.name.replace(/^minecraft:/, "");
  const wantPick =
    n.includes("stone") ||
    n.includes("cobble") ||
    n.includes("ore") ||
    n.includes("deepslate") ||
    n === "netherrack" ||
    n.includes("brick") ||
    n.includes("concrete") ||
    n === "obsidian" ||
    n.includes("basalt") ||
    n.includes("blackstone");
  const wantShovel =
    n === "dirt" ||
    n === "grass_block" ||
    n === "sand" ||
    n === "gravel" ||
    n === "dirt_path" ||
    n.includes("snow") ||
    n === "clay" ||
    n === "soul_sand";

  const items = bot.inventory.items();
  const score = (name: string): number => {
    const tier =
      name.startsWith("netherite_") ? 50 : name.startsWith("diamond_") ? 40 : name.startsWith("iron_") ? 30 : name.startsWith("stone_") ? 20 : name.startsWith("golden_") ? 15 : name.startsWith("wooden_") ? 10 : 0;
    if (wantPick && name.endsWith("_pickaxe")) return 100 + tier;
    if (wantShovel && name.endsWith("_shovel")) return 100 + tier;
    if (name.endsWith("_pickaxe")) return 40 + tier;
    if (name.endsWith("_axe") && (n.includes("log") || n.includes("plank") || n.includes("wood"))) return 90 + tier;
    if (name.endsWith("_shovel")) return 20 + tier;
    return 0;
  };

  let best: (typeof items)[0] | null = null;
  let bestS = 0;
  for (const it of items) {
    const s = score(it.name);
    if (s > bestS) {
      bestS = s;
      best = it;
    }
  }
  if (!best || bestS <= 0) return;
  if (bot.heldItem?.name === best.name) return;
  try {
    await bot.equip(best, "hand");
  } catch {
    /* */
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

import type { Bot } from "mineflayer";

/** Tool selection + scaffold item helpers (no BotInstance dependency). */

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
 * Equip the right tool before digging: mineflayer-tool when available,
 * otherwise a pickaxe/shovel/axe score fallback.
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
    /* plugin missing/failed → fallback */
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
      name.startsWith("netherite_") ? 50
      : name.startsWith("diamond_") ? 40
      : name.startsWith("iron_") ? 30
      : name.startsWith("stone_") ? 20
      : name.startsWith("golden_") ? 15
      : name.startsWith("wooden_") ? 10
      : 0;
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
    /* best-effort */
  }
}

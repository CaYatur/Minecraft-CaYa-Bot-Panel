import type { Bot } from "mineflayer";

/**
 * Creative-mode support (issue #3): when the bot is in creative, material
 * requirements are auto-cancelled and required items are conjured into the
 * inventory the way any creative player would pull them from the creative
 * inventory (bot.creative.setInventorySlot).
 */

export function isCreativeMode(bot: Bot | null | undefined): boolean {
  const gm = (bot as unknown as { game?: { gameMode?: string } } | null | undefined)?.game?.gameMode;
  return gm === "creative";
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().reduce((s, i) => s + (i.name === name ? i.count : 0), 0);
}

/** First free slot in main inventory + hotbar (window slots 9..44). */
function findFreeSlot(bot: Bot): number {
  const inv = bot.inventory;
  // prefer hotbar so the item is immediately equipable
  for (let s = inv.hotbarStart; s < inv.hotbarStart + 9; s++) {
    if (!inv.slots[s]) return s;
  }
  for (let s = inv.inventoryStart; s < inv.inventoryEnd; s++) {
    if (!inv.slots[s]) return s;
  }
  return -1;
}

/**
 * Ensure at least `min` of the item exists in inventory by conjuring a stack
 * (creative only). Returns true when the item is available afterwards.
 */
export async function creativeEnsureItem(bot: Bot, itemName: string, min = 1): Promise<boolean> {
  const name = itemName.replace(/^minecraft:/, "");
  if (countItem(bot, name) >= min) return true;
  if (!isCreativeMode(bot)) return false;

  const def = bot.registry.itemsByName[name];
  if (!def) return false;

  const slot = findFreeSlot(bot);
  if (slot < 0) return false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const makeItem = require("prismarine-item") as (registry: unknown) => new (
      id: number,
      count: number
    ) => unknown;
    const Item = makeItem(bot.registry);
    const stack = Math.max(1, Math.min(def.stackSize ?? 64, 64));
    const creative = (bot as unknown as {
      creative?: { setInventorySlot(slot: number, item: unknown): Promise<void> };
    }).creative;
    if (!creative) return false;
    await creative.setInventorySlot(slot, new Item(def.id, stack));
    // server ack is async — give it a moment
    const deadline = Date.now() + 1_200;
    while (Date.now() < deadline) {
      if (countItem(bot, name) >= Math.min(min, stack)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return countItem(bot, name) > 0;
  } catch {
    return false;
  }
}

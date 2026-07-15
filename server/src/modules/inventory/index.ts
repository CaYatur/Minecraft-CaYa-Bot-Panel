import type { Bot, EquipmentDestination } from "mineflayer";
import type { Item } from "prismarine-item";
import type { BotInstance } from "../../core/BotInstance";
import { PanelError } from "../../core/errors";
import type { InventoryItem, InventorySnapshot } from "../../types";

/** Oyuncu inventoryi window düzeni (TODO.md Faz 5) */
export const SLOTS = {
  ARMOR: [5, 6, 7, 8] as const, // helmet, chest, legs, boots
  MAIN_START: 9,
  MAIN_END: 35,
  HOTBAR_START: 36,
  HOTBAR_END: 44,
  OFFHAND: 45
} as const;

export function snapshotInventory(bot: Bot): InventorySnapshot {
  const slots: (InventoryItem | null)[] = [];
  for (let i = 0; i <= SLOTS.OFFHAND; i++) {
    const item = bot.inventory.slots[i];
    slots.push(item ? serializeItem(bot, item) : null);
  }
  return { slots, heldQuickBar: bot.quickBarSlot ?? 0, ts: Date.now() };
}

/** main inventory + hotbar dolu slot sayısı (36 = tamamen dolu) */
export function usedMainSlots(snap: InventorySnapshot): number {
  let used = 0;
  for (let i = SLOTS.MAIN_START; i <= SLOTS.HOTBAR_END; i++) if (snap.slots[i]) used++;
  return used;
}

function serializeItem(bot: Bot, item: Item): InventoryItem {
  const registry = (bot as unknown as { registry?: { items?: Record<number, { maxDurability?: number }> } }).registry;
  const maxDur = registry?.items?.[item.type]?.maxDurability;

  let durability: InventoryItem["durability"];
  try {
    if (maxDur && maxDur > 0) {
      durability = { left: Math.max(0, maxDur - (item.durabilityUsed ?? 0)), max: maxDur };
    }
  } catch {
    /* bazı eşyalarda nbt ayrıştırması sürpriz yapabilir — dayanıklılıksız göster */
  }

  let enchants: string[] = [];
  try {
    const raw = (item as unknown as { enchants?: Array<{ name: string; lvl: number }> }).enchants;
    if (Array.isArray(raw)) enchants = raw.map((e) => `${e.name} ${e.lvl}`);
  } catch {
    /* noop */
  }

  return {
    slot: item.slot,
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    durability,
    enchants
  };
}

/** eşya adına göre kuşanma targeti */
export function equipDestination(name: string): EquipmentDestination {
  if (name.endsWith("_helmet") || name === "turtle_helmet" || name === "carved_pumpkin") return "head";
  if (name.endsWith("_chestplate") || name === "elytra") return "torso";
  if (name.endsWith("_leggings")) return "legs";
  if (name.endsWith("_boots")) return "feet";
  if (name === "shield" || name === "totem_of_undying") return "off-hand";
  return "hand";
}

const UNEQUIP_DESTS: Record<string, EquipmentDestination> = {
  head: "head",
  torso: "torso",
  legs: "legs",
  feet: "feet",
  "off-hand": "off-hand"
};

export interface InventoryOp {
  op?: string;
  slot?: number;
  dest?: string;
  amount?: number;
  quickBar?: number;
  from?: number;
  to?: number;
}

/**
 * Panelden gelen inventory işlemini çalıştırır. Kısıt zorlaması (İ: TODO Faz 5):
 * - bannedItems: kuşanılamaz / ele alınamaz (önce yasağı kaldır)
 * - keepItems: atılamaz
 * İşlem bitene dek await edilir; hatalar PanelError olarak anlamlı Türkçe mesajla döner.
 */
export async function runInventoryOp(instance: BotInstance, input: InventoryOp): Promise<void> {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new PanelError("Bot offline — inventory action unavailable.");

  const banned = instance.config.inventory.bannedItems;
  const keep = instance.config.inventory.keepItems;

  const itemAt = (slot: unknown): Item => {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 0 || n > SLOTS.OFFHAND) throw new PanelError("Invalid slot number.");
    const item = bot.inventory.slots[n];
    if (!item) throw new PanelError("That slot is empty.");
    return item;
  };

  switch (String(input.op ?? "")) {
    case "equip": {
      const item = itemAt(input.slot);
      if (banned.includes(item.name)) {
        throw new PanelError(`"${item.displayName}" is banned — remove the ban before equipping.`);
      }
      await bot.equip(item, equipDestination(item.name));
      return;
    }
    case "hold": {
      const item = itemAt(input.slot);
      if (banned.includes(item.name)) {
        throw new PanelError(`"${item.displayName}" is banned — remove the ban before holding it.`);
      }
      await bot.equip(item, "hand");
      return;
    }
    case "unequip": {
      const dest = UNEQUIP_DESTS[String(input.dest ?? "")];
      if (!dest) throw new PanelError("Invalid unequip target (head/torso/legs/feet/off-hand).");
      await bot.unequip(dest);
      return;
    }
    case "toss": {
      const item = itemAt(input.slot);
      if (keep.includes(item.name)) {
        throw new PanelError(`"${item.displayName}" is kept — remove keep before dropping.`);
      }
      const amount = Math.max(1, Math.min(item.count, Math.floor(Number(input.amount ?? item.count))));
      if (amount >= item.count) await bot.tossStack(item);
      else await bot.toss(item.type, null, amount);
      return;
    }
    case "setHotbar": {
      const n = Number(input.quickBar);
      if (!Number.isInteger(n) || n < 0 || n > 8) throw new PanelError("Hotbar slot must be 0-8.");
      bot.setQuickBarSlot(n);
      return;
    }
    case "moveSlot": {
      const from = Number(input.from);
      const to = Number(input.to);
      for (const v of [from, to]) {
        if (!Number.isInteger(v) || v < SLOTS.ARMOR[0] || v > SLOTS.OFFHAND) throw new PanelError("Invalid slot number.");
      }
      itemAt(from); // source must be filled
      await bot.moveSlotItem(from, to);
      return;
    }
    default:
      throw new PanelError(`Unknown inventory operation: ${input.op ?? "(empty)"}`);
  }
}

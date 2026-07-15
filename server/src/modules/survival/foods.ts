/** Food values (approx saturation+food points for priority). Blacklist handled by config. */

export interface FoodInfo {
  name: string;
  /** higher = eat first when hungry */
  score: number;
  raw?: boolean;
}

const FOODS: FoodInfo[] = [
  { name: "golden_carrot", score: 100 },
  { name: "cooked_beef", score: 90 },
  { name: "cooked_porkchop", score: 90 },
  { name: "cooked_mutton", score: 85 },
  { name: "cooked_salmon", score: 80 },
  { name: "cooked_cod", score: 75 },
  { name: "cooked_chicken", score: 75 },
  { name: "baked_potato", score: 70 },
  { name: "bread", score: 65 },
  { name: "cooked_rabbit", score: 65 },
  { name: "mushroom_stew", score: 60 },
  { name: "beetroot_soup", score: 55 },
  { name: "apple", score: 40 },
  { name: "carrot", score: 35 },
  { name: "potato", score: 30, raw: true },
  { name: "beef", score: 25, raw: true },
  { name: "porkchop", score: 25, raw: true },
  { name: "mutton", score: 25, raw: true },
  { name: "chicken", score: 20, raw: true },
  { name: "rabbit", score: 20, raw: true },
  { name: "cod", score: 18, raw: true },
  { name: "salmon", score: 18, raw: true },
  { name: "sweet_berries", score: 15 },
  { name: "melon_slice", score: 12 },
  { name: "cookie", score: 10 },
  { name: "dried_kelp", score: 8 }
];

const BY_NAME = new Map(FOODS.map((f) => [f.name, f]));

export function foodScore(name: string): number {
  return BY_NAME.get(name)?.score ?? 0;
}

export function isFood(name: string): boolean {
  return BY_NAME.has(name) || name.endsWith("_stew") || name.includes("pie");
}

export function isRawMeat(name: string): boolean {
  return BY_NAME.get(name)?.raw === true || ["beef", "porkchop", "mutton", "chicken", "rabbit", "cod", "salmon"].includes(name);
}

/** Map raw → cooked for furnace */
export const RAW_TO_COOKED: Record<string, string> = {
  beef: "cooked_beef",
  porkchop: "cooked_porkchop",
  mutton: "cooked_mutton",
  chicken: "cooked_chicken",
  rabbit: "cooked_rabbit",
  cod: "cooked_cod",
  salmon: "cooked_salmon",
  potato: "baked_potato"
};

export const HUNTABLE = new Set(["cow", "pig", "sheep", "chicken", "rabbit", "mooshroom"]);

export const FUEL_PRIORITY = ["coal", "charcoal", "coal_block", "blaze_rod", "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "oak_planks", "stick"];

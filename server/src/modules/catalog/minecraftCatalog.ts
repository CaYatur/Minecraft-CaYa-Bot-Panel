/**
 * Sürüme göre item/block/ore kataloğu — minecraft-data (Prismarine, sürüm bazlı güncel paket).
 * Panel seçicileri ve otomasyon formları buradan beslenir.
 */

export interface CatalogEntry {
  id: string;
  name: string;
  displayName: string;
  stackSize?: number;
}

export interface MinecraftCatalog {
  version: string;
  resolvedVersion: string;
  items: CatalogEntry[];
  blocks: CatalogEntry[];
  ores: CatalogEntry[];
  foods: CatalogEntry[];
  tools: CatalogEntry[];
  weapons: CatalogEntry[];
}

const cache = new Map<string, MinecraftCatalog>();

function loadData(version: string): { version: string; data: any } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mcData = require("minecraft-data");
  const v = version === "auto" || !version ? "1.20.4" : version;
  try {
    const data = mcData(v);
    if (data) return { version: data.version?.minecraftVersion ?? v, data };
  } catch {
    /* try fallback */
  }
  // en yakın desteklenen
  const supported: string[] = mcData.supportedVersions?.pc ?? mcData.versions?.map((x: any) => x.minecraftVersion) ?? [];
  const fallback = supported.includes("1.20.4")
    ? "1.20.4"
    : supported.includes("1.16.5")
      ? "1.16.5"
      : supported[supported.length - 1] ?? "1.20.4";
  const data = mcData(fallback);
  return { version: data?.version?.minecraftVersion ?? fallback, data };
}

function entriesFromMap(byName: Record<string, { name: string; displayName?: string; stackSize?: number }>): CatalogEntry[] {
  return Object.values(byName)
    .map((it) => ({
      id: it.name,
      name: it.name,
      displayName: it.displayName || humanize(it.name),
      stackSize: it.stackSize
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "tr"));
}

function humanize(name: string): string {
  return name
    .replace(/^minecraft:/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function getCatalog(version: string): MinecraftCatalog {
  const key = version || "auto";
  const hit = cache.get(key);
  if (hit) return hit;

  const { version: resolved, data } = loadData(key);
  if (!data) {
    const empty: MinecraftCatalog = {
      version: key,
      resolvedVersion: "unknown",
      items: [],
      blocks: [],
      ores: [],
      foods: [],
      tools: [],
      weapons: []
    };
    return empty;
  }

  const items = entriesFromMap(data.itemsByName ?? {});
  const blocks = entriesFromMap(data.blocksByName ?? {});

  const ores = blocks.filter(
    (b) =>
      b.name.includes("_ore") ||
      b.name === "ancient_debris" ||
      b.name === "raw_iron_block" ||
      b.name === "raw_gold_block" ||
      b.name === "raw_copper_block"
  );

  const foods = items.filter((i) => {
    const def = data.foodsByName?.[i.name] ?? data.foods?.[i.name];
    if (def) return true;
    // fallback heuristics
    return (
      i.name.includes("cooked") ||
      i.name.includes("bread") ||
      i.name.includes("apple") ||
      i.name.includes("stew") ||
      i.name.includes("soup") ||
      i.name.endsWith("_meat") ||
      ["beef", "porkchop", "mutton", "chicken", "rabbit", "cod", "salmon", "carrot", "potato", "melon_slice", "cookie", "sweet_berries"].includes(
        i.name
      )
    );
  });

  const tools = items.filter(
    (i) =>
      i.name.endsWith("_pickaxe") ||
      i.name.endsWith("_axe") ||
      i.name.endsWith("_shovel") ||
      i.name.endsWith("_hoe") ||
      i.name === "shears" ||
      i.name === "flint_and_steel"
  );

  const weapons = items.filter(
    (i) => i.name.endsWith("_sword") || i.name.endsWith("_axe") || i.name === "trident" || i.name === "bow" || i.name === "crossbow"
  );

  const catalog: MinecraftCatalog = {
    version: key,
    resolvedVersion: resolved,
    items,
    blocks,
    ores,
    foods,
    tools,
    weapons
  };
  cache.set(key, catalog);
  // also cache under resolved
  cache.set(resolved, catalog);
  return catalog;
}

/** Sık kullanılan maden kimlikleri (otomasyon varsayılanları) — katalogda yoksa yine göster */
export const COMMON_ORES = [
  "coal_ore",
  "iron_ore",
  "gold_ore",
  "diamond_ore",
  "emerald_ore",
  "lapis_ore",
  "redstone_ore",
  "copper_ore",
  "nether_quartz_ore",
  "nether_gold_ore",
  "ancient_debris"
];

export const COMMON_LOGS = [
  "oak_log",
  "birch_log",
  "spruce_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log"
];

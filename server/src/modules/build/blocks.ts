/**
 * Şema blok sınıflandırması — yerleştirilemeyen / çoklu / özel.
 */

/** Yerleştirme denemesi atlanır (sunucu / bot sınırları) */
export const SKIP_BLOCKS = new Set([
  "air",
  "cave_air",
  "void_air",
  "structure_void",
  "barrier",
  "light",
  "nether_portal",
  "end_portal",
  "end_gateway",
  "moving_piston",
  "piston_head",
  "bubble_column",
  "fire",
  "soul_fire"
]);

/** Üst yarı — alt parça ile birlikte gelir; ayrı koyma */
export function isUpperHalf(name: string, props?: Record<string, string | number | boolean>): boolean {
  const n = name.replace(/^minecraft:/, "");
  if (props?.half === "upper" || props?.part === "head" || props?.part === "foot" && props?.occupied === true) {
    // bed head still needs place — skip only door upper / tall plant upper
  }
  if (props?.half === "upper") {
    if (n.includes("door") || n.includes("plant") || n === "sunflower" || n === "lilac" || n === "rose_bush" || n === "peony" || n === "tall_grass" || n === "large_fern") {
      return true;
    }
  }
  if (n.endsWith("_door") && props?.half === "upper") return true;
  if ((n === "tall_seagrass" || n === "tall_grass" || n === "large_fern") && props?.half === "upper") return true;
  return false;
}

/** Bed foot/head — mineflayer genelde foot yerleştirir */
export function isBedHead(name: string, props?: Record<string, string | number | boolean>): boolean {
  return name.includes("bed") && props?.part === "head";
}

export function shouldSkipBlock(name: string, props?: Record<string, string | number | boolean>): string | null {
  const n = name.replace(/^minecraft:/, "");
  if (SKIP_BLOCKS.has(n)) return "yerleştirilemez";
  if (isUpperHalf(n, props)) return "üst yarı (alt ile gelir)";
  if (isBedHead(n, props)) return "yatak başı (ayak ile gelir)";
  return null;
}

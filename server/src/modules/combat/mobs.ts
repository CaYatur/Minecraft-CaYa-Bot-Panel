/** Hostile (or commonly fought) mobs for clear-mobs / defense mode. */

const HOSTILE = new Set([
  "zombie",
  "husk",
  "drowned",
  "zombie_villager",
  "skeleton",
  "stray",
  "wither_skeleton",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "phantom",
  "slime",
  "magma_cube",
  "blaze",
  "ghast",
  "hoglin",
  "zoglin",
  "piglin_brute",
  "vindicator",
  "evoker",
  "pillager",
  "ravager",
  "vex",
  "guardian",
  "elder_guardian",
  "shulker",
  "silverfish",
  "endermite",
  "warden",
  "breeze",
  "bogged"
]);

export function isHostileMob(name: string): boolean {
  const n = name.replace(/^minecraft:/, "").toLowerCase();
  return HOSTILE.has(n);
}

export function isPlayerEntity(entity: { type?: string; username?: string }): boolean {
  return entity.type === "player" || Boolean(entity.username);
}

/** Creeper preferred standoff distance (explosion radius ~3, keep ~5) */
export const CREEPER_SAFE_RANGE = 5.5;

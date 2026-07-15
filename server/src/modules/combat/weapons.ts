/**
 * Melee weapon selection (Faz 6, D8). Bows/tridents: Backlog.
 * Higher score = preferred. bannedItems must be filtered by caller.
 */

/** Approximate full-charge attack speed (1/s) for modern combat (1.9+) */
const ATTACK_SPEED: Record<string, number> = {
  wooden_sword: 1.6,
  stone_sword: 1.6,
  iron_sword: 1.6,
  golden_sword: 1.6,
  diamond_sword: 1.6,
  netherite_sword: 1.6,
  wooden_axe: 0.8,
  stone_axe: 0.8,
  iron_axe: 0.9,
  golden_axe: 1.0,
  diamond_axe: 1.0,
  netherite_axe: 1.0,
  trident: 1.1,
  wooden_pickaxe: 1.2,
  stone_pickaxe: 1.2,
  iron_pickaxe: 1.2,
  golden_pickaxe: 1.2,
  diamond_pickaxe: 1.2,
  netherite_pickaxe: 1.2,
  wooden_shovel: 1.0,
  stone_shovel: 1.0,
  iron_shovel: 1.0,
  golden_shovel: 1.0,
  diamond_shovel: 1.0,
  netherite_shovel: 1.0,
  wooden_hoe: 1.0,
  stone_hoe: 2.0,
  iron_hoe: 3.0,
  golden_hoe: 1.0,
  diamond_hoe: 4.0,
  netherite_hoe: 4.0
};

/** Preference score: netherite sword first, bare hand last */
const WEAPON_SCORE: Record<string, number> = {
  netherite_sword: 100,
  diamond_sword: 90,
  iron_sword: 80,
  stone_sword: 70,
  wooden_sword: 60,
  golden_sword: 55,
  netherite_axe: 85,
  diamond_axe: 75,
  iron_axe: 65,
  stone_axe: 50,
  wooden_axe: 40,
  golden_axe: 45,
  trident: 72
};

const FIST_SPEED = 4.0;

export function weaponScore(itemName: string): number {
  if (WEAPON_SCORE[itemName] != null) return WEAPON_SCORE[itemName]!;
  if (itemName.endsWith("_sword")) return 50;
  if (itemName.endsWith("_axe")) return 35;
  return 0;
}

/** ms to wait for a full-charge swing (1.9+). 1.8.x callers use CPS instead. */
export function cooldownMsForWeapon(itemName: string | undefined, useModern: boolean, cpsCap: number): number {
  if (!useModern) {
    const cps = Math.max(1, Math.min(20, cpsCap || 8));
    return Math.ceil(1000 / cps);
  }
  const speed = (itemName && ATTACK_SPEED[itemName]) || FIST_SPEED;
  return Math.ceil(1000 / Math.max(0.5, speed));
}

export function isMeleeWeapon(itemName: string): boolean {
  return weaponScore(itemName) > 0;
}

/**
 * Pick best held melee from inventory item names (slot order irrelevant).
 * Returns null → bare hand.
 */
export function pickBestWeaponName(itemNames: string[], banned: string[]): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const name of itemNames) {
    if (banned.includes(name)) continue;
    const s = weaponScore(name);
    if (s > bestScore) {
      bestScore = s;
      best = name;
    }
  }
  return best;
}

import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { v3 } from "./vec3util";

/**
 * Shared low-level helpers for the build pipeline (place / scaffold / stock).
 * Kept dependency-free (no BotInstance import) to avoid module cycles.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dist3(bot: Bot, x: number, y: number, z: number): number {
  const p = bot.entity?.position;
  if (!p) return 999;
  const dx = p.x - x;
  const dy = p.y - y;
  const dz = p.z - z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function namesMatch(a: string, b: string): boolean {
  const x = a.replace(/^minecraft:/, "");
  const y = b.replace(/^minecraft:/, "");
  return x === y || x.replace(/_block$/, "") === y.replace(/_block$/, "");
}

/** Blocks a placement may overwrite without digging. */
export function isReplaceableBlock(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "air" ||
    n === "cave_air" ||
    n === "void_air" ||
    n === "water" ||
    n === "lava" ||
    n === "flowing_water" ||
    n === "flowing_lava" ||
    n === "bubble_column" ||
    n === "short_grass" ||
    n === "tall_grass" ||
    n === "grass" ||
    n === "fern" ||
    n === "large_fern" ||
    n === "dead_bush" ||
    n === "seagrass" ||
    n === "tall_seagrass" ||
    n === "snow" ||
    n === "vine" ||
    n.includes("fire")
  );
}

export function isAirLike(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return n === "air" || n === "cave_air" || n === "void_air";
}

export function isLiquid(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return n === "water" || n === "lava" || n === "flowing_water" || n === "flowing_lava" || n === "bubble_column";
}

export function isUnbreakable(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "bedrock" ||
    n === "barrier" ||
    n === "command_block" ||
    n === "chain_command_block" ||
    n === "repeating_command_block" ||
    n === "structure_block" ||
    n === "jigsaw" ||
    n === "end_portal" ||
    n === "end_portal_frame" ||
    n === "nether_portal"
  );
}

/** Blocks that fall without support below (need a solid block or scaffold under them). */
export function isGravityBlock(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "sand" ||
    n === "red_sand" ||
    n === "gravel" ||
    n === "suspicious_sand" ||
    n === "suspicious_gravel" ||
    n.endsWith("_concrete_powder") ||
    n === "anvil" ||
    n === "chipped_anvil" ||
    n === "damaged_anvil" ||
    n === "dragon_egg" ||
    n === "scaffolding" ||
    n === "powder_snow"
  );
}

/** True when the cell contains something a player/bot can stand on. */
export function isSolidStand(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return false;
  if (isReplaceableBlock(b.name) || isAirLike(b.name)) return false;
  return b.boundingBox !== "empty";
}

/**
 * Poll until the block at pos matches one of the names (or predicate), within budget.
 * Placement confirm on laggy servers: single 35 ms check caused false "failed"
 * results and double placements — poll instead.
 */
export async function waitForBlockMatch(
  bot: Bot,
  pos: Vec3,
  matches: (name: string) => boolean,
  budgetMs = 500
): Promise<string | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const b = bot.blockAt(pos);
    if (b && matches(b.name)) return b.name;
    if (Date.now() >= deadline) return null;
    await sleep(25);
  }
}

/** Facing → yaw the PLAYER must look so the placed block gets that facing (stairs family: block facing = player facing). */
export function yawForFacing(facing: string): number | null {
  // MC yaw: 0 = south(+z), π/2 = west(−x), π = north(−z), −π/2 = east(+x)
  switch (facing) {
    case "south":
      return 0;
    case "west":
      return Math.PI / 2;
    case "north":
      return Math.PI;
    case "east":
      return -Math.PI / 2;
    default:
      return null;
  }
}

/** Opposite cardinal (for blocks that face TOWARD the player, e.g. furnace/chest). */
export function oppositeFacing(facing: string): string {
  switch (facing) {
    case "north":
      return "south";
    case "south":
      return "north";
    case "east":
      return "west";
    case "west":
      return "east";
    default:
      return facing;
  }
}

/** Blocks whose `facing` equals the player's facing at place time (look same way). */
export function facesLikeStairs(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return n.endsWith("_stairs");
}

/** Blocks that face toward the player at place time (look opposite way). */
export function facesTowardPlayer(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "furnace" ||
    n === "blast_furnace" ||
    n === "smoker" ||
    n === "chest" ||
    n === "trapped_chest" ||
    n === "ender_chest" ||
    n === "barrel" ||
    n === "lectern" ||
    n === "loom" ||
    n === "stonecutter" ||
    n === "grindstone" ||
    n === "beehive" ||
    n === "bee_nest" ||
    n === "observer" ||
    n === "dispenser" ||
    n === "dropper" ||
    n === "hopper" ||
    n === "carved_pumpkin" ||
    n === "jack_o_lantern" ||
    n.endsWith("_glazed_terracotta")
  );
}

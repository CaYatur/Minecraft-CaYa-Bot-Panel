import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";

/**
 * Door passage assist.
 *
 * Pathfinder puts waypoints on the door collision slab (getPositionOnTopOf),
 * so the 0.6-wide player snags the 0.1875-thick leaf. Open doors are still
 * `physical`, so a 1-block doorway looks like a wall. After we click a door,
 * `useOne` can leave pathfinder in `placing=true` and it waits forever.
 *
 * Fix: treat wooden doors/gates as walkable for A*, force path nodes to the
 * cell center, open on approach, and push forward through the center when stuck.
 */

const installedBots = new WeakSet<Bot>();
const STALL_MS = 350;
const ACTIVATE_COOLDOWN_MS = 450;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export function isWoodenOpenableBlock(block: { name?: string } | null | undefined): boolean {
  const name = String(block?.name ?? "").toLowerCase();
  if (!name || name.includes("iron_")) return false;
  return name.endsWith("_door") || name.endsWith("_fence_gate") || name.endsWith("_trapdoor");
}

function propsOf(block: { getProperties?: () => unknown; _properties?: Record<string, unknown> }): Record<string, unknown> {
  if (block._properties && typeof block._properties === "object") return block._properties;
  if (typeof block.getProperties === "function") {
    try {
      return (block.getProperties() as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

export function resolveDoorActivateTarget(bot: Bot, block: NonNullable<ReturnType<Bot["blockAt"]>>): NonNullable<ReturnType<Bot["blockAt"]>> {
  const props = propsOf(block);
  if (props.half === "upper") {
    const lower = bot.blockAt(block.position.offset(0, -1, 0));
    if (lower && isWoodenOpenableBlock(lower)) return lower;
  }
  return block;
}

function findNearbyDoor(
  bot: Bot,
  radius: number,
  opts?: { includeOpen?: boolean }
): NonNullable<ReturnType<Bot["blockAt"]>> | null {
  const base = bot.entity?.position;
  if (!base) return null;
  const includeOpen = opts?.includeOpen !== false;
  let best: NonNullable<ReturnType<Bot["blockAt"]>> | null = null;
  let bestDistance = radius + 0.001;
  const reach = Math.max(1, Math.ceil(radius));
  const origin = base.floored();
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const block = bot.blockAt(origin.offset(dx, dy, dz));
        if (!block || !isWoodenOpenableBlock(block)) continue;
        const target = resolveDoorActivateTarget(bot, block);
        const props = propsOf(target);
        if (!includeOpen && props.open === true) continue;
        const distance = base.distanceTo(target.position.offset(0.5, 0.5, 0.5));
        if (distance < bestDistance) {
          best = target;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
}

function centerDoorPathNodes(bot: Bot, path: Array<{ x: number; y: number; z: number; toBreak?: unknown[]; toPlace?: unknown[] }>): void {
  if (!Array.isArray(path)) return;
  for (const node of path) {
    if (!node) continue;
    if ((node.toBreak?.length ?? 0) > 0 || (node.toPlace?.length ?? 0) > 0) continue;
    const x = Math.floor(node.x);
    const y = Math.floor(node.y);
    const z = Math.floor(node.z);
    const here = bot.blockAt(new Vec3(x, y, z));
    const below = bot.blockAt(new Vec3(x, y - 1, z));
    // getPositionOnTopOf puts Y on top of the 1-high door AABB → bot jumps.
    // Stand in the doorway cell, not on the door.
    if (isWoodenOpenableBlock(here)) {
      node.x = x + 0.5;
      node.y = y;
      node.z = z + 0.5;
    } else if (isWoodenOpenableBlock(below)) {
      node.x = x + 0.5;
      node.y = y - 1;
      node.z = z + 0.5;
    }
  }
}

function pathfinderHasGoal(bot: Bot): boolean {
  try {
    return Boolean((bot.pathfinder as unknown as { goal?: unknown }).goal);
  } catch {
    return false;
  }
}

/** Installed once per bot. Centers door waypoints and unsticks from the slab. */
export function installDoorMovementAssist(bot: Bot): void {
  if (installedBots.has(bot)) return;
  installedBots.add(bot);

  let lastPos: Vec3 | null = null;
  let lastProgressAt = Date.now();
  let lastActivateAt = 0;
  let nudging = false;

  const onPathUpdate = (results: { path?: Array<{ x: number; y: number; z: number }> }) => {
    if (results?.path) centerDoorPathNodes(bot, results.path);
  };
  bot.on("path_update", onPathUpdate);

  const onPhysicsTick = () => {
    const entity = bot.entity;
    if (!entity) return;
    const now = Date.now();
    if (lastPos && entity.position.distanceTo(lastPos) >= 0.08) {
      lastPos = entity.position.clone();
      lastProgressAt = now;
      if (nudging) {
        nudging = false;
        try {
          bot.setControlState("forward", true);
        } catch {
          /* */
        }
      }
    } else if (!lastPos) {
      lastPos = entity.position.clone();
      lastProgressAt = now;
    }

    if (!pathfinderHasGoal(bot)) {
      if (nudging) {
        nudging = false;
        try {
          bot.setControlState("forward", false);
        } catch {
          /* */
        }
      }
      return;
    }

    const door = findNearbyDoor(bot, 1.6, { includeOpen: true });
    if (!door) return;
    const live = bot.blockAt(door.position);
    const target = live ? resolveDoorActivateTarget(bot, live) : door;
    const name = String(target.name ?? "").toLowerCase();
    const isTrap = name.includes("trapdoor");
    const closed = propsOf(target).open !== true;
    // Re-read state so we never click an already-open door (that would close it).
    if (!isTrap && closed && now - lastActivateAt >= ACTIVATE_COOLDOWN_MS) {
      lastActivateAt = now;
      void bot.activateBlock(target).catch(() => {});
    }

    const sameLevel = Math.abs(entity.position.y - target.position.y) < 1.15;
    // Pathfinder physics.canWalkJump sees the 1-high door slab and jumps.
    // Always suppress jump in the doorway; do not wait for a stall.
    if (sameLevel) {
      try {
        bot.setControlState("jump", false);
      } catch {
        /* */
      }
    }

    const stalled = now - lastProgressAt >= STALL_MS;
    if (!stalled) return;

    const cx = door.position.x + 0.5;
    const cz = door.position.z + 0.5;
    const px = entity.position.x;
    const pz = entity.position.z;
    const dx = cx - px;
    const dz = cz - pz;
    const len = Math.hypot(dx, dz) || 1;
    // Aim at the cell center, then slightly past it so we don't stop on the slab.
    const lookX = cx + (dx / len) * 0.45;
    const lookZ = cz + (dz / len) * 0.45;
    try {
      bot.lookAt(new Vec3(lookX, entity.position.y + 1.5, lookZ), true);
    } catch {
      /* */
    }
    try {
      bot.setControlState("forward", true);
      bot.setControlState("sprint", false);
      bot.setControlState("jump", false);
      nudging = true;
    } catch {
      /* */
    }
  };

  bot.on("physicsTick", onPhysicsTick);
}

async function walkThroughDoorway(bot: Bot, door: NonNullable<ReturnType<Bot["blockAt"]>>): Promise<void> {
  const entity = bot.entity;
  if (!entity) return;
  const cx = door.position.x + 0.5;
  const cz = door.position.z + 0.5;
  const px = entity.position.x;
  const pz = entity.position.z;
  const dx = cx - px;
  const dz = cz - pz;
  const len = Math.hypot(dx, dz) || 1;
  const tx = cx + (dx / len) * 0.9;
  const tz = cz + (dz / len) * 0.9;
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }
  try {
    await bot.lookAt(new Vec3(tx, entity.position.y + 1.55, tz), false);
  } catch {
    /* */
  }
  try {
    bot.setControlState("forward", true);
    bot.setControlState("sprint", false);
    bot.setControlState("jump", false);
  } catch {
    /* */
  }
  const started = Date.now();
  while (Date.now() - started < 700) {
    const p = bot.entity?.position;
    if (!p) break;
    if (Math.hypot(p.x - tx, p.z - tz) < 0.42) break;
    // Made it into the doorway cell — keep going a bit past the slab.
    if (Math.floor(p.x) === door.position.x && Math.floor(p.z) === door.position.z && Date.now() - started > 280) {
      /* still pushing */
    }
    await sleep(40);
  }
  try {
    bot.setControlState("forward", false);
  } catch {
    /* */
  }
}

/**
 * Open a nearby wooden door/gate if closed, then walk through the cell center.
 * Also handles an already-open door the bot is snagged on.
 */
export async function tryPassNearbyDoor(instance: BotInstance, radius = 2.8): Promise<boolean> {
  const bot = instance.bot;
  if (!bot || instance.status !== "online" || !bot.entity) return false;
  const door = findNearbyDoor(bot, radius, { includeOpen: true });
  if (!door) return false;
  const props = propsOf(door);
  try {
    if (props.open !== true) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
      await bot.lookAt(door.position.offset(0.5, 0.5, 0.5), false);
      await bot.activateBlock(door);
      await sleep(180);
    }
    await walkThroughDoorway(bot, door);
    return true;
  } catch {
    return false;
  }
}

/** @deprecated use tryPassNearbyDoor — kept so callers that only wanted a click still compile */
export async function tryOpenNearbyDoor(instance: BotInstance, radius = 2.8): Promise<boolean> {
  return tryPassNearbyDoor(instance, radius);
}

/** Apply A* walkability for wooden doors/gates on a Movements instance. */
export function patchMovementsForDoors(bot: Bot, movements: object): void {
  const m = movements as {
    getBlock: (pos: { x: number; y: number; z: number } | null, dx: number, dy: number, dz: number) => {
      name?: string;
      safe?: boolean;
      physical?: boolean;
      height?: number;
    };
  };
  const origGetBlock = m.getBlock.bind(m);
  m.getBlock = (pos, dx, dy, dz) => {
    const b = origGetBlock(pos, dx, dy, dz);
    if (!b?.name) return b;
    const name = b.name.toLowerCase();
    if (name.includes("iron_")) return b;
    const doorOrGate = name.endsWith("_door") || name.endsWith("_fence_gate");
    const trap = name.endsWith("_trapdoor");
    if (!doorOrGate && !trap) return b;
    const open = propsOf(b as { getProperties?: () => unknown }).open === true;
    // Closed doors/gates must still be pathable or a 1-wide doorway is a wall.
    // Open trapdoors are air; closed trapdoors stay solid (floor/ceiling).
    if (doorOrGate || (trap && open)) {
      b.safe = true;
      b.physical = false;
      if (pos) b.height = pos.y + dy;
    }
    return b;
  };
  void bot;
}

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";
import { isParkourLocked } from "./parkour";

/**
 * Door passage assist.
 *
 * Pathfinder puts waypoints on the door collision slab (getPositionOnTopOf),
 * so the 0.6-wide player snags the 0.1875-thick leaf. Open doors are still
 * `physical`, so a 1-block doorway looks like a wall. After we click a door,
 * `useOne` can leave pathfinder in `placing=true` and it waits forever.
 *
 * Reversed / maze doors: "open" is not always passable. The 0.1875 leaf sits on
 * one face (facing + hinge). If that face is on our travel axis, toggle
 * (open or close). If the far cell is empty, the door is a two-way passage.
 *
 * Fix: treat wooden doors/gates as walkable for A*, force path nodes to the
 * lower cell, toggle only when the leaf blocks our axis, walk the clear side.
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

function isDoorOrGateBlock(block: { name?: string } | null | undefined): boolean {
  const name = String(block?.name ?? "").toLowerCase();
  if (!name) return false;
  if (name.endsWith("_fence_gate") && !name.includes("iron_")) return true;
  return name.endsWith("_door");
}

function isIronDoorBlock(block: { name?: string } | null | undefined): boolean {
  const name = String(block?.name ?? "").toLowerCase();
  return name.endsWith("_door") && name.includes("iron");
}

function isDoorControlBlock(block: { name?: string } | null | undefined): boolean {
  const name = String(block?.name ?? "").toLowerCase();
  if (!name) return false;
  return name.endsWith("_button") || name === "lever" || name.endsWith("_pressure_plate") || name.includes("pressure_plate");
}

function controlKind(name: string): "button" | "lever" | "plate" {
  const n = name.toLowerCase();
  if (n.includes("pressure_plate")) return "plate";
  if (n.includes("lever")) return "lever";
  return "button";
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
    if (lower && (isWoodenOpenableBlock(lower) || isIronDoorBlock(lower))) return lower;
  }
  return block;
}

function findDoorControl(
  bot: Bot,
  door: { position: { x: number; y: number; z: number }; name?: string }
): NonNullable<ReturnType<Bot["blockAt"]>> | null {
  const base = bot.entity?.position;
  if (!base) return null;
  const doorOpen = propsOf(door as { getProperties?: () => unknown }).open === true;
  const doorCenter = new Vec3(door.position.x + 0.5, door.position.y + 0.5, door.position.z + 0.5);
  let best: NonNullable<ReturnType<Bot["blockAt"]>> | null = null;
  let bestScore = Infinity;
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy) > 5) continue;
        const block = bot.blockAt(new Vec3(door.position.x + dx, door.position.y + dy, door.position.z + dz));
        if (!block || !isDoorControlBlock(block)) continue;
        const center = block.position.offset(0.5, 0.5, 0.5);
        const distBot = base.distanceTo(center);
        if (distBot > 4.5) continue;
        const kind = controlKind(block.name);
        const powered = propsOf(block).powered === true;
        if (kind === "lever" && doorOpen && powered) continue;
        if (kind === "lever" && !doorOpen && powered) continue;
        const score = distBot * 1.15 + doorCenter.distanceTo(center) * 0.4 + (kind === "plate" ? 0.7 : 0);
        if (score < bestScore) {
          best = block;
          bestScore = score;
        }
      }
    }
  }
  return best;
}

function findNearbyDoor(
  bot: Bot,
  radius: number,
  opts?: { includeOpen?: boolean; doorsAndGatesOnly?: boolean }
): NonNullable<ReturnType<Bot["blockAt"]>> | null {
  const base = bot.entity?.position;
  if (!base) return null;
  const includeOpen = opts?.includeOpen !== false;
  const match = opts?.doorsAndGatesOnly ? isDoorOrGateBlock : isWoodenOpenableBlock;
  let best: NonNullable<ReturnType<Bot["blockAt"]>> | null = null;
  let bestDistance = radius + 0.001;
  const reach = Math.max(1, Math.ceil(radius));
  const origin = base.floored();
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const block = bot.blockAt(origin.offset(dx, dy, dz));
        if (!block || !match(block)) continue;
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
    // getPositionOnTopOf parks on the 1-high door AABB (Y = door+1 / upper half).
    // Always stand in the lower door cell or the bot jumps into the doorway.
    const door = isDoorOrGateBlock(here) ? here : isDoorOrGateBlock(below) ? below : null;
    if (!door) continue;
    const feet = resolveDoorActivateTarget(bot, door);
    node.x = feet.position.x + 0.5;
    node.y = feet.position.y;
    node.z = feet.position.z + 0.5;
  }
}

type DoorFace = "north" | "south" | "east" | "west";

function isAirishBlock(block: { name?: string; boundingBox?: string } | null | undefined): boolean {
  if (!block) return true;
  const n = String(block.name ?? "").replace(/^minecraft:/, "").toLowerCase();
  if (n === "air" || n === "cave_air" || n === "void_air" || n === "light" || n === "barrier") return true;
  if (block.boundingBox && block.boundingBox !== "block") return true;
  return false;
}

function cellIsPassage(bot: Bot, x: number, y: number, z: number): boolean {
  const feet = bot.blockAt(new Vec3(x, y, z));
  const head = bot.blockAt(new Vec3(x, y + 1, z));
  if (isDoorOrGateBlock(feet) || isDoorOrGateBlock(head)) return true;
  if (isWoodenOpenableBlock(feet) || isWoodenOpenableBlock(head)) return true;
  return isAirishBlock(feet) && isAirishBlock(head);
}

/** Which face holds the 0.1875 collision leaf (vanilla DoorBlock / FenceGateBlock). */
function doorCollisionFace(block: { name?: string; getProperties?: () => unknown; _properties?: Record<string, unknown> }): DoorFace | null {
  const name = String(block.name ?? "").toLowerCase();
  const props = propsOf(block);
  const facing = String(props.facing ?? "").toLowerCase() as DoorFace | "";
  const open = props.open === true;
  if (name.includes("fence_gate")) {
    if (open) return null;
    if (facing === "north" || facing === "south" || facing === "east" || facing === "west") return facing;
    return null;
  }
  if (!name.endsWith("_door")) return null;
  const hingeRight = String(props.hinge ?? "").toLowerCase() === "right";
  if (!open) {
    if (facing === "east" || facing === "west" || facing === "north" || facing === "south") return facing;
    return "north";
  }
  switch (facing) {
    case "east":
      return hingeRight ? "north" : "south";
    case "south":
      return hingeRight ? "east" : "west";
    case "west":
      return hingeRight ? "south" : "north";
    case "north":
    default:
      return hingeRight ? "west" : "east";
  }
}

function slabBlocksAxis(slab: DoorFace | null, axis: "x" | "z"): boolean {
  if (!slab) return false;
  if (axis === "x") return slab === "east" || slab === "west";
  return slab === "north" || slab === "south";
}

function passOffset(slab: DoorFace | null): { x: number; z: number } {
  const o = 0.22;
  if (slab === "north") return { x: 0, z: o };
  if (slab === "south") return { x: 0, z: -o };
  if (slab === "west") return { x: o, z: 0 };
  if (slab === "east") return { x: -o, z: 0 };
  return { x: 0, z: 0 };
}

function travelThroughDoor(
  bot: Bot,
  door: { position: { x: number; y: number; z: number } },
  lastPath: Array<{ x: number; y: number; z: number }> | null
): { dx: number; dz: number } {
  if (lastPath) {
    for (const n of lastPath) {
      const nx = Math.floor(n.x) - door.position.x;
      const nz = Math.floor(n.z) - door.position.z;
      if (nx !== 0 || nz !== 0) return { dx: nx, dz: nz };
    }
  }
  try {
    const g = (
      bot.pathfinder as unknown as {
        goal?: { x?: number; z?: number; entity?: { position?: { x: number; z: number } } };
      }
    ).goal;
    const gx = g?.entity?.position?.x ?? g?.x;
    const gz = g?.entity?.position?.z ?? g?.z;
    if (typeof gx === "number" && typeof gz === "number") {
      return { dx: gx - (door.position.x + 0.5), dz: gz - (door.position.z + 0.5) };
    }
  } catch {
    /* */
  }
  const p = bot.entity?.position;
  return {
    dx: door.position.x + 0.5 - (p?.x ?? 0),
    dz: door.position.z + 0.5 - (p?.z ?? 0)
  };
}

/** Toggle only when the leaf is on our travel axis and the far (or near) cell is a passage. */
function shouldToggleDoor(
  bot: Bot,
  door: NonNullable<ReturnType<Bot["blockAt"]>>,
  travel: { dx: number; dz: number }
): boolean {
  const name = String(door.name ?? "").toLowerCase();
  if (name.includes("trapdoor") || name.includes("iron_")) return false;
  const axis: "x" | "z" = Math.abs(travel.dx) >= Math.abs(travel.dz) ? "x" : "z";
  const slab = doorCollisionFace(door);
  if (!slabBlocksAxis(slab, axis)) return false;
  const sx = axis === "x" ? (travel.dx >= 0 ? 1 : -1) : 0;
  const sz = axis === "z" ? (travel.dz >= 0 ? 1 : -1) : 0;
  const y = door.position.y;
  const far = cellIsPassage(bot, door.position.x + sx, y, door.position.z + sz);
  const near = cellIsPassage(bot, door.position.x - sx, y, door.position.z - sz);
  if (!far && !near) return false;
  return true;
}

type DoorFail = { toggles: number; windowStart: number; until: number };
const doorFails = new WeakMap<Bot, Map<string, DoorFail>>();
const mazePauseUntil = new WeakMap<Bot, number>();

function posKey(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

function failMap(bot: Bot): Map<string, DoorFail> {
  let m = doorFails.get(bot);
  if (!m) {
    m = new Map();
    doorFails.set(bot, m);
  }
  return m;
}

function isDoorOnCooldown(bot: Bot, pos: { x: number; y: number; z: number }, now = Date.now()): boolean {
  const s = failMap(bot).get(posKey(pos));
  return Boolean(s && s.until > now);
}

function noteDoorToggle(bot: Bot, pos: { x: number; y: number; z: number }, now = Date.now()): void {
  const m = failMap(bot);
  const k = posKey(pos);
  let s = m.get(k);
  if (!s || now - s.windowStart > 4500) s = { toggles: 0, windowStart: now, until: 0 };
  s.toggles += 1;
  if (s.toggles >= 4) s.until = now + 12_000;
  m.set(k, s);
}

function giveUpOnDoor(bot: Bot, pos: { x: number; y: number; z: number }, now = Date.now(), ms = 8000): void {
  const m = failMap(bot);
  const k = posKey(pos);
  const s = m.get(k) ?? { toggles: 0, windowStart: now, until: 0 };
  s.until = Math.max(s.until, now + ms);
  m.set(k, s);
}

function goalXZ(bot: Bot): { x: number; z: number } | null {
  try {
    const g = bot.pathfinder.goal as
      | { x?: number; z?: number; entity?: { position?: { x: number; z: number } } }
      | null
      | undefined;
    if (!g) return null;
    if (g.entity?.position) return { x: g.entity.position.x, z: g.entity.position.z };
    if (typeof g.x === "number" && typeof g.z === "number") return { x: g.x, z: g.z };
  } catch {
    /* */
  }
  return null;
}

/** Skip doors that are behind us or farther from the goal than we already are (player turned back). */
function doorIsOnTheWay(bot: Bot, door: { position: { x: number; z: number } }): boolean {
  const p = bot.entity?.position;
  if (!p) return false;
  const goal = goalXZ(bot);
  if (!goal) return true;
  const dx = door.position.x + 0.5 - p.x;
  const dz = door.position.z + 0.5 - p.z;
  const gx = goal.x - p.x;
  const gz = goal.z - p.z;
  const distDoor = Math.hypot(dx, dz);
  const distGoal = Math.hypot(gx, gz);
  if (distGoal < 0.9) return false;
  if (distDoor > 0.85 && gx * dx + gz * dz < 0) return false;
  const distGoalFromDoor = Math.hypot(goal.x - (door.position.x + 0.5), goal.z - (door.position.z + 0.5));
  if (distGoalFromDoor > distGoal + 2.2 && distDoor > 1.3) return false;
  return true;
}

function doorAheadOf(bot: Bot, dist = 3.2): NonNullable<ReturnType<Bot["blockAt"]>> | null {
  const entity = bot.entity;
  if (!entity) return null;
  const yaw = entity.yaw;
  const ux = -Math.sin(yaw);
  const uz = -Math.cos(yaw);
  const py = Math.floor(entity.position.y);
  for (let t = 0; t <= dist; t += 0.5) {
    const x = Math.floor(entity.position.x + ux * t);
    const z = Math.floor(entity.position.z + uz * t);
    for (const dy of [0, 1, -1]) {
      const block = bot.blockAt(new Vec3(x, py + dy, z));
      if (block && isDoorOrGateBlock(block)) return resolveDoorActivateTarget(bot, block);
    }
  }
  return null;
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
  let lastPath: Array<{ x: number; y: number; z: number }> | null = null;

  const onPathUpdate = (results: { path?: Array<{ x: number; y: number; z: number }> }) => {
    if (results?.path) {
      lastPath = results.path;
      centerDoorPathNodes(bot, results.path);
    }
  };
  bot.on("path_update", onPathUpdate);

  const onPhysicsTick = () => {
    const entity = bot.entity;
    if (!entity) return;
    const now = Date.now();
    if (lastPath?.length) centerDoorPathNodes(bot, lastPath);
    const next = lastPath?.[0];
    const nextDoor =
      next &&
      (isDoorOrGateBlock(bot.blockAt(new Vec3(Math.floor(next.x), Math.floor(next.y), Math.floor(next.z)))) ||
        isDoorOrGateBlock(bot.blockAt(new Vec3(Math.floor(next.x), Math.floor(next.y) - 1, Math.floor(next.z)))));
    const doorEarly =
      findNearbyDoor(bot, 3.2, { includeOpen: true, doorsAndGatesOnly: true }) ??
      doorAheadOf(bot, 3.2) ??
      (nextDoor ? findNearbyDoor(bot, 4, { includeOpen: true, doorsAndGatesOnly: true }) : null);
    // Pathfinder jumps 1–3 blocks before the door because the waypoint sits on the slab.
    // Kill jump on approach and inside the cell; real parkour gaps are not doorways.
    if (entity.onGround && (nextDoor || (doorEarly && Math.abs(entity.position.y - doorEarly.position.y) < 1.6))) {
      try {
        bot.setControlState("jump", false);
      } catch {
        /* */
      }
    }
    if (isParkourLocked(bot)) return;
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

    if ((mazePauseUntil.get(bot) ?? 0) > now) {
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

    const door = findNearbyDoor(bot, 1.6, { includeOpen: true, doorsAndGatesOnly: true });
    if (!door) return;
    const live = bot.blockAt(door.position);
    const target = live ? resolveDoorActivateTarget(bot, live) : door;
    const name = String(target.name ?? "").toLowerCase();
    const isTrap = name.includes("trapdoor");
    if (isDoorOnCooldown(bot, target.position, now) || !doorIsOnTheWay(bot, target)) {
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
    const travel = travelThroughDoor(bot, target, lastPath);
    if (!isTrap && !isIronDoorBlock(target) && now - lastActivateAt >= ACTIVATE_COOLDOWN_MS && shouldToggleDoor(bot, target, travel)) {
      lastActivateAt = now;
      noteDoorToggle(bot, target.position, now);
      void bot.activateBlock(target).catch(() => {});
    }
    if (isIronDoorBlock(target) && propsOf(target).open !== true && now - lastActivateAt >= 650) {
      const ctrl = findDoorControl(bot, target);
      if (ctrl) {
        lastActivateAt = now;
        noteDoorToggle(bot, target.position, now);
        const kind = controlKind(ctrl.name);
        if (kind === "plate") {
          try {
            void bot.lookAt(ctrl.position.offset(0.5, 0.2, 0.5), true);
            bot.setControlState("forward", true);
            bot.setControlState("jump", false);
          } catch {
            /* */
          }
        } else {
          void bot.activateBlock(ctrl).catch(() => {});
        }
      }
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
    if (now - lastProgressAt >= 2800) {
      giveUpOnDoor(bot, target.position, now, 10_000);
      mazePauseUntil.set(bot, now + 4000);
      lastProgressAt = now;
      nudging = false;
      try {
        bot.setControlState("forward", false);
      } catch {
        /* */
      }
      return;
    }

    const liveNow = bot.blockAt(target.position) ?? target;
    const slab = doorCollisionFace(liveNow);
    const off = passOffset(slab);
    const cx = door.position.x + 0.5 + off.x;
    const cz = door.position.z + 0.5 + off.z;
    const px = entity.position.x;
    const pz = entity.position.z;
    const dx = cx - px;
    const dz = cz - pz;
    const len = Math.hypot(dx, dz) || 1;
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
  const live = bot.blockAt(door.position) ?? door;
  const off = passOffset(doorCollisionFace(live));
  const cx = door.position.x + 0.5 + off.x;
  const cz = door.position.z + 0.5 + off.z;
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
 * Toggle a nearby door/gate only if the leaf blocks our travel axis, then walk
 * the clear side of the cell. Reversed and maze doors may need to be closed.
 */
export async function tryPassNearbyDoor(instance: BotInstance, radius = 2.8): Promise<boolean> {
  const bot = instance.bot;
  if (!bot || instance.status !== "online" || !bot.entity) return false;
  const door = findNearbyDoor(bot, radius, { includeOpen: true, doorsAndGatesOnly: true });
  if (!door) return false;
  if (isDoorOnCooldown(bot, door.position) || !doorIsOnTheWay(bot, door)) return false;
  try {
    if (isIronDoorBlock(door)) {
      if (propsOf(door).open !== true) {
        const ctrl = findDoorControl(bot, door);
        if (!ctrl) return false;
        try {
          bot.pathfinder.setGoal(null);
        } catch {
          /* */
        }
        noteDoorToggle(bot, door.position);
        await bot.lookAt(ctrl.position.offset(0.5, 0.5, 0.5), false);
        if (controlKind(ctrl.name) === "plate") {
          bot.setControlState("forward", true);
          bot.setControlState("jump", false);
          await sleep(280);
        } else {
          await bot.activateBlock(ctrl);
          await sleep(200);
        }
        const until = Date.now() + 700;
        while (Date.now() < until) {
          const live = bot.blockAt(door.position);
          if (live && propsOf(live).open === true) break;
          await sleep(40);
        }
      }
      await walkThroughDoorway(bot, door);
      return true;
    }
    const travel = travelThroughDoor(bot, door, null);
    const snagged = bot.entity.position.distanceTo(door.position.offset(0.5, 0, 0.5)) < 1.25;
    if (!shouldToggleDoor(bot, door, travel) && !snagged) return false;
    if (shouldToggleDoor(bot, door, travel)) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
      await bot.lookAt(door.position.offset(0.5, 0.5, 0.5), false);
      noteDoorToggle(bot, door.position);
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
    if (name.includes("iron_") && name.endsWith("_trapdoor")) return b;
    const doorOrGate = name.endsWith("_door") || (name.endsWith("_fence_gate") && !name.includes("iron_"));
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

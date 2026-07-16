import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";
import { goals } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import { ensureMovement } from "../movement";
import {
  dist3,
  facesLikeStairs,
  facesTowardPlayer,
  isGravityBlock,
  isLiquid,
  isReplaceableBlock,
  isUnbreakable,
  namesMatch,
  oppositeFacing,
  sleep,
  waitForBlockMatch,
  yawForFacing
} from "./maneuver";
import { equipBestToolForBlock, pickScaffoldItem } from "./tools";
import type { ScaffoldTracker } from "./scaffold";
import { v3 } from "./vec3util";

const FACES: [number, number, number][] = [
  [0, -1, 0],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1]
];

/** Placement reach — NEVER call the pathfinder inside this radius */
export const PLACE_REACH = 4.5;
/** Path approach radius */
const PATH_RANGE = 2.8;
/** Path timeout (ms) */
const PATH_TIMEOUT_MS = 8_000;

export type PlaceResult = "placed" | "skipped" | "failed" | "outofreach" | "noitem";

export interface PlaceOptions {
  retries?: number;
  /** walking-by placement: no pathfinding, return "outofreach" instead */
  skipPath?: boolean;
  /** do not disturb pathfinder goal/controls (used while walking) */
  softSettle?: boolean;
  /** schematic block state — used for best-effort orientation */
  props?: Record<string, string | number | boolean>;
  /** called after a wrong existing block got broken (drop pickup is caller's job) */
  onFixedWrongBlock?: (pos: { x: number; y: number; z: number }, name: string) => void;
}

/**
 * soft=true: do NOT break pathfinder goal (placing while walking).
 * soft=false: stop, clear controls, settle for a stable look-and-place.
 */
async function settleForPlacement(bot: Bot, soft = false) {
  if (!soft) {
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* */
    }
    try {
      bot.clearControlStates();
    } catch {
      /* */
    }
    try {
      bot.setControlState("jump", false);
    } catch {
      /* */
    }
  }
  const v = bot.entity?.velocity;
  const moving = Boolean(v) && (Math.abs(v!.x) > 0.04 || Math.abs(v!.z) > 0.04 || Math.abs(v!.y) > 0.12);
  if (soft) {
    await sleep(moving ? 25 : 10);
    return;
  }
  await sleep(moving ? 140 : 50);
}

/** Force-release pathfinder + movement keys (used on cancel / pathNear finally). */
export function forceStopPath(bot: Bot) {
  try {
    const pf = bot.pathfinder as unknown as { setGoal?(g: null): void; stop?(): void };
    pf.stop?.();
    pf.setGoal?.(null);
  } catch {
    /* */
  }
  try {
    bot.clearControlStates();
  } catch {
    /* */
  }
}

/**
 * Dig that honors cancel: polls token and calls stopDigging so Stop/Reset
 * cannot hang forever inside `await bot.dig()` (Paper 1.21.x hang report).
 */
export async function digCancelable(bot: Bot, block: Block, token: TaskToken): Promise<void> {
  if (token.cancelled) throw new Error(token.reason ?? "cancelled");
  let settled = false;
  let digErr: unknown = null;
  const digP = bot.dig(block, true).then(
    () => {
      settled = true;
    },
    (e) => {
      settled = true;
      digErr = e;
    }
  );
  while (!settled) {
    if (token.cancelled) {
      try {
        (bot as unknown as { stopDigging?(): void }).stopDigging?.();
      } catch {
        /* */
      }
      forceStopPath(bot);
      // don't wait forever for dig promise after stopDigging
      await Promise.race([digP, sleep(400)]);
      throw new Error(token.reason ?? "cancelled");
    }
    await sleep(60);
  }
  if (token.cancelled) throw new Error(token.reason ?? "cancelled");
  if (digErr) throw digErr;
}

/**
 * Pathfind only when needed; no-op when already close.
 * clearGoal=false keeps the goal (placing while walking).
 * onTick lets the caller place blocks that come into reach en route.
 * Cancel aborts immediately (does not wait for long onTick/dig).
 */
export async function pathNear(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  range: number,
  token: TaskToken,
  opts?: { clearGoal?: boolean; timeoutMs?: number; onTick?: () => void | Promise<void> }
) {
  const bot = ensureMovement(instance);
  if (token.cancelled) throw new Error(token.reason ?? "cancelled");
  if (dist3(bot, x, y, z) <= range + 0.5) return;

  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
  const t0 = Date.now();
  const timeout = opts?.timeoutMs ?? PATH_TIMEOUT_MS;
  let noPath = false;
  let lastBest = dist3(bot, x, y, z);
  let lastProgressAt = Date.now();
  const onPath = (r: { status?: string }) => {
    if (r?.status === "noPath" || r?.status === "timeout") noPath = true;
  };
  bot.on("path_update", onPath);
  try {
    while (!token.cancelled && Date.now() - t0 < timeout) {
      if (token.cancelled) break;
      if (noPath) break;
      const d = dist3(bot, x, y, z);
      if (d <= range + 0.55) break;
      // patience while progressing; bail when stuck (do not force-wait far away)
      if (d < lastBest - 0.25) {
        lastBest = d;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > 7_000) {
        break;
      }
      if (opts?.onTick && !token.cancelled) {
        try {
          // onTick uses digCancelable — cancel aborts dig; do not fire-and-forget
          await opts.onTick();
        } catch (e) {
          if (token.cancelled) break;
          /* cluster place errors must not break the walk */
        }
      }
      if (token.cancelled) {
        forceStopPath(bot);
        break;
      }
      await sleep(40);
    }
  } finally {
    bot.removeListener("path_update", onPath);
    if (opts?.clearGoal !== false || token.cancelled) {
      forceStopPath(bot);
    }
  }
  if (token.cancelled) throw new Error(token.reason ?? "cancelled");
}

export function distToBlock(instance: BotInstance, x: number, y: number, z: number): number {
  const bot = instance.bot;
  if (!bot?.entity) return 999;
  return dist3(bot, x + 0.5, y + 0.5, z + 0.5);
}

/** Schematic block name → inventory item name(s) (liquids / special cases) */
export function itemNameForBlock(blockName: string): string[] {
  const n = blockName.replace(/^minecraft:/, "");
  if (n === "water" || n === "flowing_water") return ["water_bucket"];
  if (n === "lava" || n === "flowing_lava") return ["lava_bucket"];
  if (n === "powder_snow") return ["powder_snow_bucket"];
  if (n === "redstone_wire") return ["redstone"];
  if (n === "tripwire") return ["string"];
  if (n === "cocoa") return ["cocoa_beans"];
  if (n === "carrots") return ["carrot"];
  if (n === "potatoes") return ["potato"];
  if (n === "beetroots") return ["beetroot_seeds"];
  if (n === "melon_stem" || n === "attached_melon_stem") return ["melon_seeds"];
  if (n === "pumpkin_stem" || n === "attached_pumpkin_stem") return ["pumpkin_seeds"];
  if (n === "sweet_berry_bush") return ["sweet_berries"];
  if (n.endsWith("_wall_torch")) return [n.replace("_wall_torch", "_torch")];
  if (n === "wall_torch") return ["torch"];
  if (n.endsWith("_wall_head")) return [n.replace("_wall_head", "_head")];
  if (n.endsWith("_wall_skull")) return [n.replace("_wall_skull", "_skull")];
  if (n.endsWith("_wall_banner")) return [n.replace("_wall_banner", "_banner")];
  if (n.endsWith("_wall_fan")) return [n.replace("_wall_fan", "_fan")];
  if (n.endsWith("_wall_sign") || n.endsWith("_hanging_sign") || n.endsWith("_sign")) {
    const base = n
      .replace(/_wall_hanging_sign$/, "_hanging_sign")
      .replace(/_wall_sign$/, "_sign");
    return [base, n];
  }
  return [n];
}

/**
 * Place the named block at absolute (x,y,z).
 * opts.skipPath: while-walking placement — no pathfinding, "outofreach" when far.
 */
export async function placeBlockAt(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  blockName: string,
  token: TaskToken,
  scaffolds: ScaffoldTracker,
  opts?: PlaceOptions
): Promise<PlaceResult> {
  const retries = Math.max(1, opts?.retries ?? 1);
  let last: PlaceResult = "failed";
  for (let attempt = 0; attempt < retries; attempt++) {
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    last = await placeBlockAtOnce(instance, x, y, z, blockName, token, scaffolds, opts);
    if (last === "placed" || last === "skipped" || last === "outofreach" || last === "noitem") return last;
    if (attempt + 1 < retries) await sleep(60 + attempt * 50);
  }
  return last;
}

async function placeBlockAtOnce(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  blockName: string,
  token: TaskToken,
  scaffolds: ScaffoldTracker,
  opts?: PlaceOptions
): Promise<PlaceResult> {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline");
  const target = v3(Math.floor(x), Math.floor(y), Math.floor(z));
  const name = String(blockName).replace(/^minecraft:/, "");
  const tx = target.x + 0.5;
  const ty = target.y + 0.5;
  const tz = target.z + 0.5;
  const soft = Boolean(opts?.softSettle || opts?.skipPath);

  // --- 1) out of reach: walk FIRST, never force-place from far ---
  let d = dist3(bot, tx, ty, tz);
  if (d > PLACE_REACH) {
    if (opts?.skipPath) return "outofreach";
    await pathNear(instance, tx, target.y, tz, PATH_RANGE, token, {
      clearGoal: true,
      timeoutMs: 12_000
    });
    d = dist3(bot, tx, ty, tz);
    if (d > PLACE_REACH + 1.2) return "outofreach";
  }

  await settleForPlacement(bot, soft);

  let existing = bot.blockAt(target);
  if (existing && (existing.name === name || namesMatch(existing.name, name))) return "skipped";

  // wrong block in the cell → break it, then place the right one
  if (existing && !isReplaceableBlock(existing.name) && !namesMatch(existing.name, name)) {
    if (opts?.skipPath && dist3(bot, tx, ty, tz) > PLACE_REACH) {
      return "outofreach";
    }
    const wrongName = existing.name;
    const cleared = await clearBlockAt(instance, target, token, { skipPath: opts?.skipPath });
    if (!cleared) return opts?.skipPath ? "outofreach" : "failed";
    opts?.onFixedWrongBlock?.({ x: target.x, y: target.y, z: target.z }, wrongName);
    existing = bot.blockAt(target);
    if (existing && !isReplaceableBlock(existing.name) && !namesMatch(existing.name, name)) {
      return "failed";
    }
  }

  const itemNames = itemNameForBlock(name);
  const item = bot.inventory.items().find((i) => itemNames.includes(i.name));
  if (!item) return "noitem";

  d = dist3(bot, tx, ty, tz);
  if (opts?.skipPath && d > PLACE_REACH) return "outofreach";

  // --- standing inside / on top of the target cell: step aside; tower-jump only for pillars ---
  const occ = occupancyRelation(bot, target);
  if (occ === "feet" || occ === "head") {
    if (opts?.skipPath) return "outofreach";
    const moved = await stepAside(instance, token, target);
    if (!moved) {
      if (occ === "feet") {
        const jumped = await jumpPlaceOnBelow(instance, target, item, name, scaffolds);
        if (jumped) return "placed";
      }
      return "failed";
    }
    d = dist3(bot, tx, ty, tz);
  } else if (occ === "under") {
    if (opts?.skipPath) return "outofreach";
    const moved = await stepAside(instance, token, target);
    if (moved) {
      d = dist3(bot, tx, ty, tz);
    } else {
      const jumped = await jumpPlaceOnBelow(instance, target, item, name, scaffolds);
      if (jumped) return "placed";
      return "failed";
    }
  }

  // liquids: bucket pour
  if (
    item.name.endsWith("_bucket") &&
    (name === "water" || name === "lava" || name === "powder_snow" || name.includes("water") || name.includes("lava"))
  ) {
    if (!opts?.skipPath && d > PLACE_REACH) {
      await pathNear(instance, tx, target.y, tz, PATH_RANGE, token, { timeoutMs: 10_000 });
    }
    try {
      await bot.lookAt(target.offset(0.5, 0.25, 0.5), false);
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      bot.activateItem(false);
      await sleep(40);
      try {
        bot.deactivateItem();
      } catch {
        /* */
      }
      const matched = await waitForBlockMatch(
        bot,
        target,
        (n) => n.includes(name.split("_")[0]!) || n === name || n.includes("water") || n.includes("lava"),
        450
      );
      if (matched) {
        scaffolds.protectStructure(target.x, target.y, target.z);
        return "placed";
      }
      return "failed";
    } catch {
      return "failed";
    }
  }

  // gravity blocks (sand/gravel/…): make sure something below holds them
  if (isGravityBlock(name)) {
    const below = bot.blockAt(v3(target.x, target.y - 1, target.z));
    if (!below || isReplaceableBlock(below.name) || isLiquid(below.name)) {
      if (opts?.skipPath) return "outofreach";
      await ensureSupport(instance, target, token, scaffolds);
      const below2 = bot.blockAt(v3(target.x, target.y - 1, target.z));
      if (!below2 || isReplaceableBlock(below2.name)) return "failed";
    }
  }

  // still out of reach (partial path) → approach once more
  d = dist3(bot, tx, ty, tz);
  if (!opts?.skipPath && d > PLACE_REACH) {
    await pathNear(instance, tx, target.y, tz, PATH_RANGE, token, { timeoutMs: 10_000 });
    d = dist3(bot, tx, ty, tz);
    if (d > PLACE_REACH + 0.8) return "outofreach";
    await settleForPlacement(bot);
  }

  // still overlapping → one more sidestep
  if (occupancyRelation(bot, target) === "feet" || occupancyRelation(bot, target) === "head") {
    if (opts?.skipPath) return "outofreach";
    await stepAside(instance, token, target);
  }

  const axis = typeof opts?.props?.axis === "string" ? (opts.props.axis as string) : null;
  let ref = findReference(bot, target, axis);
  if (!ref) {
    if (opts?.skipPath) return "outofreach";
    await ensureSupport(instance, target, token, scaffolds);
    ref = findReference(bot, target, axis);
  }
  if (!ref) return "failed";

  const eyeH = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
  const eyeY = bot.entity.position.y + eyeH;
  if (target.y - eyeY > 2.8) {
    if (opts?.skipPath) return "outofreach";
    await climbWithScaffold(instance, target.y - 1, token, scaffolds);
  }

  try {
    if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
  } catch {
    return "failed";
  }

  ref = findReference(bot, target, axis) ?? ref;
  try {
    // --- best-effort orientation: face the right way before clicking ---
    await orientForPlacement(bot, name, opts?.props);
    await bot.lookAt(ref.block.position.offset(0.5, 0.5, 0.5), false);
    await genericPlace(bot, ref.block, ref.face, opts?.props);
    const okName = (n: string) => n === name || n === item.name || namesMatch(n, name) || namesMatch(n, item.name);
    const matched = await waitForBlockMatch(bot, target, okName, 500);
    if (matched) {
      scaffolds.protectStructure(target.x, target.y, target.z);
      return "placed";
    }
    return "failed";
  } catch {
    return "failed";
  }
}

/** Face the proper direction so directional blocks come out right (stairs/furnace/…). */
async function orientForPlacement(
  bot: Bot,
  name: string,
  props?: Record<string, string | number | boolean>
): Promise<void> {
  const facing = typeof props?.facing === "string" ? (props.facing as string) : null;
  if (!facing) return;
  let yaw: number | null = null;
  if (facesLikeStairs(name)) yaw = yawForFacing(facing);
  else if (facesTowardPlayer(name)) yaw = yawForFacing(oppositeFacing(facing));
  if (yaw == null) return;
  try {
    await bot.look(yaw, 0, true);
    await sleep(30);
  } catch {
    /* orientation is best-effort */
  }
}

/**
 * placeBlock with cursor options when available (slab half, stairs top half).
 * Falls back to the plain API.
 */
async function genericPlace(
  bot: Bot,
  refBlock: Block,
  face: Vec3,
  props?: Record<string, string | number | boolean>
): Promise<void> {
  const wantTop = props?.type === "top" || props?.half === "top";
  const anyBot = bot as unknown as {
    _genericPlace?: (block: Block, face: Vec3, options?: { half?: "top" | "bottom" }) => Promise<void>;
  };
  if (wantTop && typeof anyBot._genericPlace === "function") {
    try {
      await anyBot._genericPlace(refBlock, face, { half: "top" });
      return;
    } catch {
      /* fall through to plain place */
    }
  }
  await bot.placeBlock(refBlock, face);
}

/** How does the bot's body overlap the target cell? */
function occupancyRelation(bot: Bot, target: Vec3): "none" | "under" | "feet" | "head" {
  if (!bot.entity) return "none";
  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);
  if (target.x !== fx || target.z !== fz) return "none";
  if (target.y === fy - 1) return "under";
  if (target.y === fy) return "feet";
  if (target.y === fy + 1) return "head";
  return "none";
}

/** Step out of the target cell onto a solid neighbor. */
export async function stepAside(
  instance: BotInstance,
  token: TaskToken,
  awayFrom: Vec3
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity) return false;

  try {
    bot.pathfinder?.setGoal(null);
  } catch {
    /* */
  }

  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);

  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ];
  // try directions that increase distance to the target first
  dirs.sort((a, b) => {
    const da = Math.abs(fx + a[0] - awayFrom.x) + Math.abs(fz + a[1] - awayFrom.z);
    const db = Math.abs(fx + b[0] - awayFrom.x) + Math.abs(fz + b[1] - awayFrom.z);
    return db - da;
  });

  for (const [dx, dz] of dirs) {
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    const nx = fx + dx;
    const nz = fz + dz;
    const ground = bot.blockAt(v3(nx, fy - 1, nz));
    const atFeet = bot.blockAt(v3(nx, fy, nz));
    const atHead = bot.blockAt(v3(nx, fy + 1, nz));
    if (!ground || isReplaceableBlock(ground.name)) continue;
    if (atFeet && !isReplaceableBlock(atFeet.name)) continue;
    if (atHead && !isReplaceableBlock(atHead.name)) continue;

    try {
      await pathNear(instance, nx + 0.5, fy, nz + 0.5, 0.35, token, { timeoutMs: 2500, clearGoal: true });
    } catch {
      /* */
    }

    const p2 = bot.entity.position;
    if (Math.floor(p2.x) === nx && Math.floor(p2.z) === nz) return true;

    // control-state nudge
    try {
      await bot.lookAt(v3(nx + 0.5, fy + 0.5, nz + 0.5), false);
      bot.setControlState("forward", true);
      await sleep(280);
      bot.setControlState("forward", false);
      await sleep(40);
    } catch {
      try {
        bot.setControlState("forward", false);
      } catch {
        /* */
      }
    }

    const p3 = bot.entity.position;
    if (Math.floor(p3.x) !== fx || Math.floor(p3.z) !== fz) {
      if (Math.floor(p3.x) !== awayFrom.x || Math.floor(p3.z) !== awayFrom.z || Math.floor(p3.y) !== awayFrom.y) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Under-feet / pillar: jump and place on the top face of the block below.
 * target = cell under feet OR at feet level (tower one up).
 */
async function jumpPlaceOnBelow(
  instance: BotInstance,
  target: Vec3,
  item: { name: string },
  wantName: string,
  scaffolds: ScaffoldTracker
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity) return false;

  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);

  if (target.x !== fx || target.z !== fz) return false;

  let support = bot.blockAt(v3(target.x, target.y - 1, target.z));

  if (target.y === fy - 1) {
    support = bot.blockAt(v3(target.x, target.y - 1, target.z));
    if (!support || isReplaceableBlock(support.name)) {
      return false; // hole below — needs a side reference, jump-place won't work
    }
  } else if (target.y === fy) {
    support = bot.blockAt(v3(fx, fy - 1, fz));
    if (!support || isReplaceableBlock(support.name)) return false;
  } else {
    return false;
  }

  const existing = bot.blockAt(target);
  if (existing && !isReplaceableBlock(existing.name) && !namesMatch(existing.name, wantName)) {
    return false;
  }
  if (existing && namesMatch(existing.name, wantName)) {
    scaffolds.protectStructure(target.x, target.y, target.z);
    return true;
  }

  try {
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* */
    }
    if (bot.heldItem?.name !== item.name) {
      const inv = bot.inventory.items().find((i) => i.name === item.name);
      if (!inv) return false;
      await bot.equip(inv, "hand");
    }

    // one controlled jump-place (no spam)
    await bot.look(bot.entity.yaw, 1.35, false);
    bot.setControlState("jump", true);
    await sleep(90);
    try {
      await bot.placeBlock(support, v3(0, 1, 0));
      scaffolds.record(target.x, target.y, target.z, item.name);
    } catch {
      const ref = findReference(bot, target, null);
      if (ref) {
        try {
          await bot.lookAt(ref.block.position.offset(0.5, 0.5, 0.5), false);
          await bot.placeBlock(ref.block, ref.face);
        } catch {
          /* */
        }
      }
    } finally {
      try {
        bot.setControlState("jump", false);
      } catch {
        /* */
      }
    }

    const matched = await waitForBlockMatch(
      bot,
      target,
      (n) => namesMatch(n, wantName) || n === item.name || namesMatch(n, item.name),
      450
    );
    if (matched) {
      scaffolds.protectStructure(target.x, target.y, target.z);
      return true;
    }
    return false;
  } catch {
    try {
      bot.setControlState("jump", false);
    } catch {
      /* */
    }
    return false;
  }
}

/**
 * Break the wrong block at target (with the right tool).
 * Player-placed / stale / mis-pathed blocks.
 */
export async function clearBlockAt(
  instance: BotInstance,
  target: Vec3,
  token: TaskToken,
  opts?: { skipPath?: boolean }
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot) return false;
  const b = bot.blockAt(target);
  if (!b || isReplaceableBlock(b.name)) return true;
  if (isUnbreakable(b.name)) return false;

  const feet = bot.entity.position;
  const onFeet =
    Math.floor(feet.x) === target.x && Math.floor(feet.y) === target.y && Math.floor(feet.z) === target.z;
  if (onFeet) {
    try {
      bot.setControlState("back", true);
      await sleep(160);
      bot.setControlState("back", false);
      await sleep(40);
    } catch {
      /* */
    }
    const feet2 = bot.entity.position;
    if (Math.floor(feet2.x) === target.x && Math.floor(feet2.y) === target.y && Math.floor(feet2.z) === target.z) {
      return false;
    }
  }

  const tx = target.x + 0.5;
  const ty = target.y + 0.5;
  const tz = target.z + 0.5;
  if (dist3(bot, tx, ty, tz) > PLACE_REACH) {
    if (opts?.skipPath) return false;
    await pathNear(instance, tx, target.y, tz, PATH_RANGE, token);
  }
  if (token.cancelled) throw new Error(token.reason ?? "cancelled");

  const live = bot.blockAt(target);
  if (!live || isReplaceableBlock(live.name)) return true;
  if (!bot.canDigBlock(live)) return false;

  try {
    await equipBestToolForBlock(bot, live);
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), false);
    await digCancelable(bot, live, token);
    await sleep(30);
    const after = bot.blockAt(target);
    return !after || isReplaceableBlock(after.name);
  } catch (e) {
    if (token.cancelled) throw e instanceof Error ? e : new Error(token.reason ?? "cancelled");
    return false;
  }
}

/**
 * Find a solid neighbor to click against. When `axis` is given (logs/pillars),
 * prefer faces along that axis so the placed block gets the right orientation.
 */
function findReference(bot: Bot, target: Vec3, axis: string | null): { block: Block; face: Vec3 } | null {
  let faces = FACES;
  if (axis === "x") {
    faces = [[1, 0, 0], [-1, 0, 0], ...FACES.filter(([fx]) => fx === 0)] as [number, number, number][];
  } else if (axis === "z") {
    faces = [[0, 0, 1], [0, 0, -1], ...FACES.filter(([, , fz]) => fz === 0)] as [number, number, number][];
  } else if (axis === "y") {
    faces = [[0, -1, 0], [0, 1, 0], ...FACES.filter(([, fy]) => fy === 0)] as [number, number, number][];
  }
  for (const [fx, fy, fz] of faces) {
    const rp = v3(target.x + fx, target.y + fy, target.z + fz);
    const b = bot.blockAt(rp);
    if (!b || b.name === "air" || b.name === "cave_air" || b.name === "void_air" || b.name === "water" || b.name === "lava") {
      continue;
    }
    if (b.boundingBox === "empty") continue;
    const face = v3(-fx, -fy, -fz);
    return { block: b, face };
  }
  return null;
}

async function ensureSupport(
  instance: BotInstance,
  target: Vec3,
  token: TaskToken,
  scaffolds: ScaffoldTracker,
  depth = 0
) {
  const bot = instance.bot!;
  if (depth > 3) return;
  const under = v3(target.x, target.y - 1, target.z);
  const ub = bot.blockAt(under);
  if (ub && ub.name !== "air" && ub.name !== "cave_air") return;

  const scaffoldName = pickScaffoldItem(bot, instance.config.movement.scaffoldBlocks);
  if (!scaffoldName) return;

  if (dist3(bot, under.x + 0.5, under.y, under.z + 0.5) > PLACE_REACH) {
    await pathNear(instance, under.x + 0.5, under.y, under.z + 0.5, PATH_RANGE, token);
  }
  const item = bot.inventory.items().find((i) => i.name === scaffoldName);
  if (!item) return;

  let ref = findReference(bot, under, null);
  if (!ref && under.y > -64) {
    await ensureSupport(instance, under, token, scaffolds, depth + 1);
    ref = findReference(bot, under, null);
  }
  if (!ref) return;
  try {
    if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
    await bot.placeBlock(ref.block, ref.face);
    scaffolds.record(under.x, under.y, under.z, scaffoldName);
    await sleep(40);
  } catch {
    /* */
  }
}

/** Tower up on scaffold blocks until feet reach targetFootY (temporary blocks tracked). */
export async function climbWithScaffold(
  instance: BotInstance,
  targetFootY: number,
  token: TaskToken,
  scaffolds: ScaffoldTracker
) {
  const bot = instance.bot!;
  const preferred = instance.config.movement.scaffoldBlocks;
  let guard = 0;
  while (!token.cancelled && bot.entity.position.y < targetFootY - 0.5 && guard < 24) {
    guard++;
    const scaffoldName = pickScaffoldItem(bot, preferred);
    if (!scaffoldName) break;
    const item = bot.inventory.items().find((i) => i.name === scaffoldName);
    if (!item) break;

    const fx = Math.floor(bot.entity.position.x);
    const fy = Math.floor(bot.entity.position.y);
    const fz = Math.floor(bot.entity.position.z);
    try {
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      const below = bot.blockAt(v3(fx, fy - 1, fz));
      if (below && below.name !== "air") {
        bot.setControlState("jump", true);
        await sleep(120);
        try {
          await bot.placeBlock(below, v3(0, 1, 0));
          scaffolds.record(fx, fy, fz, scaffoldName);
        } catch {
          /* */
        }
        bot.setControlState("jump", false);
        await sleep(140);
      } else {
        break;
      }
    } catch {
      bot.setControlState("jump", false);
      break;
    }
  }
}

import type { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import type { BotInstance } from "../../core/BotInstance";
import type { ProgressFn, TaskToken } from "../../core/TaskQueue";
import type { MovementConfig } from "../../types";
import { v3 } from "../build/vec3util";

/**
 * Gelişmiş parkur:
 * - pathfinder allowParkour + sprint (2 blok boşluklar)
 * - özel gap jump: 2 / 3 / 4 blok yatay atlama
 * - merdiven: tırman + merdivenden merdivene / kenara atlama
 */

export type ParkourGap = 2 | 3 | 4;

export interface ParkourConfig {
  /** pathfinder parkour (varsayılan true) */
  enabled: boolean;
  /** özel gap jump üst sınırı: 2 | 3 | 4 (aynı Y). Aşağı sprint daha uzağa gidebilir. */
  maxGap: ParkourGap;
  /** merdiven parkuru / tırmanma */
  ladderParkour: boolean;
  /** sprint zorunlu (3–4 blok for) */
  sprintJumps: boolean;
}

export function parkourFromMovement(cfg: MovementConfig): ParkourConfig {
  const maxGap = Math.min(4, Math.max(2, Math.floor(cfg.parkourMaxGap ?? 3))) as ParkourGap;
  return {
    enabled: cfg.allowParkour !== false,
    maxGap,
    ladderParkour: cfg.ladderParkour !== false,
    sprintJumps: cfg.parkourSprint !== false
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const parkourLocks = new WeakSet<Bot>();

export function isParkourLocked(bot: Bot | null | undefined): boolean {
  return Boolean(bot && parkourLocks.has(bot));
}

/** circular import yok — parkour kendi Movements kurar */
function ensureParkourBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline");
  const anyBot = bot as unknown as { pathfinder?: { setMovements(m: unknown): void; setGoal(g: unknown): void } };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);
  const cfg = instance.config.movement;
  const movements = new Movements(bot);
  const placeOk = cfg.allowPlace !== false;
  movements.canDig = cfg.canDig !== false;
  movements.allowSprinting = cfg.parkourSprint !== false && cfg.allowSprint !== false;
  movements.allowParkour = cfg.allowParkour !== false;
  movements.allow1by1towers = placeOk && Boolean(cfg.allowTower);
  if (!placeOk) movements.scafoldingBlocks = [];
  try {
    (movements as { maxDropDown?: number }).maxDropDown = Math.max(cfg.maxDrop ?? 3, Math.min(8, (cfg.parkourMaxGap ?? 3) + 2));
  } catch {
    /* */
  }
  patchMovementsForTurningLadders(movements);
  bot.pathfinder.setMovements(movements);
  return bot;
}

function clearControls(bot: Bot) {
  for (const k of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
    try {
      bot.setControlState(k, false);
    } catch {
      /* */
    }
  }
}

// caya-rubberband-fix-v1: Pathfinder ile manuel kontrol arasında tek sahipli safe devir.
const caya_rubberband_fix_v1 = true;
async function handoffToManualControl(bot: Bot, settleMs = 140): Promise<void> {
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* pathfinder henüz hazır olmayabilir */
  }
  clearControls(bot);

  const until = Date.now() + Math.max(40, settleMs);
  while (Date.now() < until) {
    try {
      const pf = bot.pathfinder as unknown as { isMoving?(): boolean };
      if (pf.isMoving?.() === false) break;
    } catch {
      break;
    }
    await sleep(20);
  }

  // En az iki fizik tick'i: eski pathfinder kontrol paketlerinin boşalması for.
  await sleep(50);
  clearControls(bot);
}

async function alignManualLookAt(bot: Bot, target: ReturnType<typeof v3>): Promise<void> {
  // force=false: anlık yaw sıçraması/anti-cheat düzeltmesi üretmez.
  try {
    await bot.lookAt(target, false);
  } catch {
    /* bakış failedsa hareket kodu safe biçimde devam eder */
  }
  await sleep(50);
}

async function alignManualYaw(bot: Bot, yaw: number, pitch = 0): Promise<void> {
  try {
    await bot.look(yaw, pitch, false);
  } catch {
    /* bakış failedsa hareket kodu safe biçimde devam eder */
  }
  await sleep(50);
}

function isSolid(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return false;
  const n = b.name.replace(/^minecraft:/, "");
  if (n === "air" || n === "cave_air" || n === "void_air" || n === "water" || n === "lava") return false;
  if (b.boundingBox && b.boundingBox !== "block") return false;
  return true;
}

function isAirish(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return true;
  const n = b.name.replace(/^minecraft:/, "");
  return n === "air" || n === "cave_air" || n === "void_air" || n === "light";
}

/** Stand on THIS Y — a pit floor 2 down is not "still on the platform". */
function isPlatformStand(bot: Bot, x: number, y: number, z: number): boolean {
  return isSolid(bot, x, y - 1, z) && isAirish(bot, x, y, z) && isAirish(bot, x, y + 1, z);
}

function isOpenableCell(bot: Bot, x: number, y: number, z: number): boolean {
  for (const dy of [0, -1, 1]) {
    const b = bot.blockAt(v3(x, y + dy, z));
    const n = String(b?.name ?? "").toLowerCase();
    if (!n || n.includes("iron_")) continue;
    if (n.endsWith("_door") || n.endsWith("_fence_gate") || n.endsWith("_trapdoor")) return true;
  }
  return false;
}

function isNearOpenable(bot: Bot, radius = 1.8): boolean {
  const p = bot.entity?.position;
  if (!p) return false;
  const o = p.floored();
  const r = Math.max(1, Math.ceil(radius));
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        if (!isOpenableCell(bot, o.x + dx, o.y + dy, o.z + dz)) continue;
        if (Math.hypot(p.x - (o.x + dx + 0.5), p.z - (o.z + dz + 0.5)) <= radius) return true;
      }
    }
  }
  return false;
}

/** Y the player would stand at in this cell, or null if nothing to land on. */
function standYAt(bot: Bot, x: number, yHint: number, z: number, maxDown = 8): number | null {
  for (let dy = 0; dy >= -maxDown; dy--) {
    if (isPlatformStand(bot, x, yHint + dy, z)) return yHint + dy;
  }
  if (isPlatformStand(bot, x, yHint + 1, z)) return yHint + 1;
  return null;
}

/** Same-level 1–2 block hops stay on pathfinder. We only take long / down sprint jumps. */
export function isLongSprintGap(land: { y: number; gap: number }, botY: number): boolean {
  const drop = botY - land.y;
  return land.gap >= 4 || (drop >= 2 && land.gap >= 3) || (drop >= 4 && land.gap >= 2);
}

function maxAirForDrop(drop: number, sameLevelMax: number): number {
  // Same-level sprint jump tops out around 4. An L-corner looks like a 6–8 gap.
  if (drop <= 0.6) return Math.min(4, sameLevelMax);
  return Math.min(10, 4 + Math.min(Math.floor(drop), 6));
}

/** True only if a sprint-jump can actually land this gap (not an L-shortcut). */
function jumpIsReachable(fromY: number, land: { y: number; gap: number }): boolean {
  const drop = fromY - land.y;
  if (drop < -1.2) return false;
  return land.gap <= maxAirForDrop(drop, 4);
}

function maxSafeDrop(bot: Bot): number {
  const hp = Math.max(0, bot.health ?? 20);
  return Math.min(10, 3 + Math.max(0, Math.floor(hp - 4)));
}

/** Horizontal distance to the first hole at the current platform Y. */
function distToFrontEdge(bot: Bot, ux: number, uz: number): number {
  const pos = bot.entity?.position;
  if (!pos) return 0;
  const py = Math.floor(pos.y);
  for (let t = 0.05; t <= 4.05; t += 0.1) {
    const x = Math.floor(pos.x + ux * t);
    const z = Math.floor(pos.z + uz * t);
    // Doors are a walk-through, not a cliff.
    if (isOpenableCell(bot, x, py, z) || isPlatformStand(bot, x, py, z)) continue;
    return t;
  }
  return 4;
}

async function waitTicks(bot: Bot, ticks: number): Promise<void> {
  try {
    await bot.waitForTicks(ticks);
  } catch {
    await sleep(Math.max(50, ticks * 50));
  }
}

function isLadder(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return false;
  const n = b.name.replace(/^minecraft:/, "");
  return n === "ladder" || n === "vine" || n.includes("vine") || n === "scaffolding" || n === "twisting_vines" || n === "weeping_vines";
}

const CARDINAL_XZ = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 }
];

type PathNode = { x: number; y: number; z: number };

function ladderFacingVec(bot: Bot, x: number, y: number, z: number): { x: number; z: number } | null {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return null;
  let face = "";
  try {
    face = String((b as { getProperties?: () => { facing?: string } }).getProperties?.()?.facing ?? "").toLowerCase();
  } catch {
    face = "";
  }
  if (face === "north") return { x: 0, z: -1 };
  if (face === "south") return { x: 0, z: 1 };
  if (face === "west") return { x: -1, z: 0 };
  if (face === "east") return { x: 1, z: 0 };
  return null;
}

/** Two ladders on opposite walls of a shaft — not a spiral step. */
function isOpposingLadder(bot: Bot, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const fa = ladderFacingVec(bot, ax, ay, az);
  const fb = ladderFacingVec(bot, bx, by, bz);
  if (!fa || !fb) return false;
  if (fa.x !== -fb.x || fa.z !== -fb.z) return false;
  const dx = Math.sign(bx - ax);
  const dz = Math.sign(bz - az);
  return (fa.x !== 0 && dx === fa.x) || (fa.z !== 0 && dz === fa.z);
}

function ladderHasSideRung(bot: Bot, x: number, y: number, z: number): boolean {
  for (const d of CARDINAL_XZ) {
    for (const dy of [0, 1, -1]) {
      if (!isLadder(bot, x + d.x, y + dy, z + d.z)) continue;
      if (isOpposingLadder(bot, x, y, z, x + d.x, y + dy, z + d.z)) continue;
      return true;
    }
  }
  return false;
}

/** Dönmeli / spiral merdiven — düz kolon değil. Pathfinder sarsın, hop/hijack yok. */
export function isTurningLadder(bot: Bot): boolean {
  if (!bot.entity) return false;
  const fx = Math.floor(bot.entity.position.x);
  const fy = Math.floor(bot.entity.position.y);
  const fz = Math.floor(bot.entity.position.z);
  const start = findNearbyLadder(bot, fx, fy, fz);
  const x = start?.x ?? fx;
  const z = start?.z ?? fz;
  const y0 = start?.y ?? fy;
  for (let dy = -16; dy <= 16; dy++) {
    if (!isLadder(bot, x, y0 + dy, z)) continue;
    if (ladderHasSideRung(bot, x, y0 + dy, z)) return true;
  }
  return false;
}

/**
 * Pathfinder only climbs the same XZ column (getMoveUp) and has no one-rung
 * climb-down. Spiral/turning ladders also need a neighbor onto the offset rung.
 * Long drops from a climbable are stripped so A* does not jump off the spiral.
 */
export function patchMovementsForTurningLadders(movements: unknown) {
  const m = movements as {
    bot?: Bot;
    getBlock: (
      node: PathNode,
      dx: number,
      dy: number,
      dz: number
    ) => { climbable?: boolean; safe?: boolean };
    getNeighbors: (node: PathNode) => unknown[];
  };
  const orig = m.getNeighbors.bind(m);
  m.getNeighbors = (node: PathNode) => {
    const neighbors = orig(node);
    addTurningLadderMoves(m, node, neighbors);
    addWaterExits(m as unknown as { getBlock: (n: PathNode, dx: number, dy: number, dz: number) => CellInfo & { liquid?: boolean; name?: string } }, node, neighbors);
    pruneImpossibleLadderMoves(m as unknown as { getBlock: (n: PathNode, dx: number, dy: number, dz: number) => CellInfo }, node, neighbors);
    pruneParkourWithoutRunUp(m as unknown as { getBlock: (n: PathNode, dx: number, dy: number, dz: number) => CellInfo }, node, neighbors);
    return neighbors;
  };
}

/**
 * A 3+ block parkour jump (or 2 up) needs a run-up. Off the end of a 1-wide beam,
 * sideways, there is none: the bot jumped from a standstill and fell (issue #34).
 * Keep such a move only when the cell behind the takeoff can be stood on; the
 * takeoff planner backs into it for speed.
 */
function pruneParkourWithoutRunUp(
  m: { getBlock: (node: PathNode, dx: number, dy: number, dz: number) => CellInfo },
  node: PathNode,
  neighbors: unknown[]
) {
  for (let i = neighbors.length - 1; i >= 0; i--) {
    const mv = neighbors[i] as PathNode & { parkour?: boolean };
    if (!mv.parkour) continue;
    const dx = mv.x - node.x;
    const dz = mv.z - node.z;
    const gap = Math.max(Math.abs(dx), Math.abs(dz)) - 1;
    // A standing jump clears 2 blocks at the same height or lower (beam to beam
    // sideways); 3+, or 2 up, needs a run-up.
    if (gap < 2 || (gap === 2 && mv.y <= node.y)) continue;
    const sx = Math.sign(dx);
    const sz = Math.sign(dz);
    try {
      const floor = m.getBlock(node, -sx, -1, -sz);
      const feet = m.getBlock(node, -sx, 0, -sz);
      const head = m.getBlock(node, -sx, 1, -sz);
      if (floor?.physical && feet?.safe && head?.safe) continue;
    } catch {
      /* unknown cells: keep the move */
      continue;
    }
    neighbors.splice(i, 1);
  }
}

/**
 * Pathfinder climbs a ladder one node past the top rung, into the air above it, and
 * then plans from that node as if the bot stood there. With a player on the only
 * exit block it picked a 4-block parkour jump from mid-air (issue #34) and the bot
 * bobbed on the top rung forever. Nothing on a ladder has ground to jump from, so
 * parkour moves from a rung or from the air above the top rung are dropped.
 */
function pruneImpossibleLadderMoves(
  m: { getBlock: (node: PathNode, dx: number, dy: number, dz: number) => CellInfo },
  node: PathNode,
  neighbors: unknown[]
) {
  let onRung = false;
  let aboveTop = false;
  try {
    const here = m.getBlock(node, 0, 0, 0);
    const below = m.getBlock(node, 0, -1, 0);
    onRung = Boolean(here?.climbable);
    // a ladder counts as "physical" (thin collision box), but nobody stands on it
    aboveTop = !onRung && Boolean(below?.climbable) && Boolean(here?.safe);
  } catch {
    return;
  }
  if (!onRung && !aboveTop) return;
  for (let i = neighbors.length - 1; i >= 0; i--) {
    const mv = neighbors[i] as PathNode & { parkour?: boolean };
    if (!mv.parkour) continue;
    // A 1-block hop off a ladder onto a wall top works (a player does it all the
    // time); longer jumps need ground to sprint from. Spiral rungs and step-offs stay.
    const reach = Math.max(Math.abs(mv.x - node.x), Math.abs(mv.z - node.z));
    if (reach <= 2 && mv.y <= node.y + 0.5) continue;
    neighbors.splice(i, 1);
  }
}

function addTurningLadderMoves(
  m: {
    bot?: Bot;
    getBlock: (
      node: PathNode,
      dx: number,
      dy: number,
      dz: number
    ) => { climbable?: boolean; safe?: boolean };
  },
  node: PathNode,
  neighbors: unknown[]
) {
  let here: { climbable?: boolean };
  try {
    here = m.getBlock(node, 0, 0, 0);
  } catch {
    return;
  }
  if (!here?.climbable) return;
  for (let i = neighbors.length - 1; i >= 0; i--) {
    const mv = neighbors[i] as { x: number; y: number; z: number };
    if (mv.y >= node.y - 1) continue;
    let destClimb = false;
    try {
      destClimb = Boolean(m.getBlock(mv, 0, 0, 0)?.climbable);
    } catch {
      destClimb = false;
    }
    if (!destClimb) neighbors.splice(i, 1);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Move = require("mineflayer-pathfinder/lib/move") as new (
    x: number,
    y: number,
    z: number,
    remainingBlocks: number,
    cost: number,
    toBreak: unknown[],
    toPlace: unknown[],
    parkour?: boolean
  ) => unknown;
  const remaining = (node as { remainingBlocks?: number }).remainingBlocks ?? 0;
  const bot = m.bot;
  try {
    const below = m.getBlock(node, 0, -1, 0);
    if (below?.climbable) {
      neighbors.push(new Move(node.x, node.y - 1, node.z, remaining, 1, [], [], false));
    }
  } catch {
    /* */
  }
  for (const dir of CARDINAL_XZ) {
    for (const dy of [-2, -1, 0, 1, 2]) {
      try {
        const dest = m.getBlock(node, dir.x, dy, dir.z);
        if (!dest?.climbable) continue;
        const head = m.getBlock(node, dir.x, dy + 1, dir.z);
        if (head && !head.safe && !head.climbable) continue;
        if (
          bot &&
          isOpposingLadder(bot, node.x, node.y, node.z, node.x + dir.x, node.y + dy, node.z + dir.z)
        ) {
          continue;
        }
        const cost = dy < 0 ? 0.95 : 1.15;
        neighbors.push(
          new Move(node.x + dir.x, node.y + dy, node.z + dir.z, remaining, cost, [], [], false)
        );
      } catch {
        /* */
      }
    }
  }
  // Spiral ladders wrap a pillar: the next rung is on the next face, one block up
  // and diagonal. Allowed when one of the two corner cells is open to pass through.
  for (const dir of DIAGONAL_XZ) {
    for (const dy of [-1, 0, 1]) {
      try {
        const dest = m.getBlock(node, dir.x, dy, dir.z);
        if (!dest?.climbable) continue;
        const lo = Math.max(0, dy);
        const open = (dx: number, dz: number) =>
          [lo, lo + 1].every((h) => {
            const c = m.getBlock(node, dx, h, dz);
            return Boolean(c?.safe) && !(c as CellInfo)?.physical;
          });
        if (!open(dir.x, 0) && !open(0, dir.z)) continue;
        const exists = neighbors.some((n) => {
          const mv = n as PathNode;
          return mv.x === node.x + dir.x && mv.y === node.y + dy && mv.z === node.z + dir.z;
        });
        if (exists) continue;
        neighbors.push(new Move(node.x + dir.x, node.y + dy, node.z + dir.z, remaining, dy < 0 ? 1.3 : 1.6, [], [], false));
      } catch {
        /* */
      }
    }
  }
  addLadderTopExits(m, node, neighbors, Move, remaining);
}

const DIAGONAL_XZ = [
  { x: 1, z: 1 },
  { x: 1, z: -1 },
  { x: -1, z: 1 },
  { x: -1, z: -1 }
];

const spiralAssisted = new WeakSet<Bot>();

/**
 * Turning/spiral ladders (issue #34): pathfinder steers by walking physics, so on a
 * rung it either stops pushing or steps off too early and the bot drops 4 blocks.
 * While the next path node is a rung in another column, hold climb and only push
 * toward it once a short physics look-ahead says the bot grabs that rung.
 */
export function installSpiralLadderAssist(bot: Bot): void {
  if (spiralAssisted.has(bot)) return;
  spiralAssisted.add(bot);
  let path: Array<{ x: number; y: number; z: number }> | null = null;
  let committed: { x: number; y: number; z: number; until: number; startY: number } | null = null;
  let tickNo = 0;
  bot.on("path_update", (r: { path?: Array<{ x: number; y: number; z: number }> }) => {
    path = r.path ?? null; // pathfinder shifts this same array as it walks
    // a re-plan (the followed player moved) must not drop a grab already under way
  });
  bot.on("goal_reached", () => {
    path = null;
    committed = null;
  });
  for (const ev of ["path_reset", "goal_updated", "path_stop", "caya_teleported"]) {
    bot.on(ev as never, (() => {
      path = null;
      if (ev !== "path_reset") committed = null;
    }) as never);
  }
  bot.on("physicsTick", () => {
    tickNo++;
    try {
      if (!bot.entity || isParkourLocked(bot) || !bot.pathfinder.goal) {
        committed = null;
        return;
      }
      const p = bot.entity.position;
      const fx = Math.floor(p.x);
      const fy = Math.floor(p.y);
      const fz = Math.floor(p.z);
      if (committed) {
        // kept through re-plans: a following goal re-plans every time the player moves
        const inTarget = fx === committed.x && fz === committed.z && fy === committed.y;
        if (inTarget || tickNo > committed.until || p.y < committed.startY - 1.2) {
          committed = null;
          return; // grabbed (pathfinder carries on) or missed
        }
        steer(committed, true);
        return;
      }
      if (!path || path.length === 0) return;
      const moving = (bot.pathfinder as unknown as { isMoving?: () => boolean }).isMoving?.();
      if (!moving) return;
      if (!isLadder(bot, fx, fy, fz)) return;
      const n = path[0]!;
      const cx = Math.floor(n.x);
      const cy = Math.floor(n.y);
      const cz = Math.floor(n.z);
      if ((cx === fx && cz === fz) || cy < fy || Math.abs(cx - fx) > 1 || Math.abs(cz - fz) > 1) return;
      if (!isLadder(bot, cx, cy, cz)) return;
      const target = { x: cx, y: cy, z: cz };
      const go = grabsRungIfPushing(bot, target);
      if (go) committed = { ...target, until: tickNo + 16, startY: p.y };
      steer(target, go);
    } catch {
      /* never break the physics loop */
    }
  });

  function yawTo(t: { x: number; z: number }) {
    const p = bot.entity.position;
    return Math.atan2(-(t.x + 0.5 - p.x), -(t.z + 0.5 - p.z));
  }
  function steer(t: { x: number; y: number; z: number }, push: boolean) {
    void bot.look(yawTo(t), 0, true).catch(() => undefined);
    bot.setControlState("jump", true); // climb
    bot.setControlState("forward", push);
    bot.setControlState("sprint", push);
    bot.setControlState("back", false);
    bot.setControlState("left", false);
    bot.setControlState("right", false);
  }
}

/** Physics look-ahead: pushing toward the rung from now on, do we end up holding it? */
function grabsRungIfPushing(bot: Bot, rung: { x: number; y: number; z: number }): boolean {
  if (!playerStateCtor) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    playerStateCtor = (require(require.resolve("prismarine-physics", { paths: [require.resolve("mineflayer")] })) as {
      PlayerState: PlayerStateCtor;
    }).PlayerState;
  }
  const physics = (bot as unknown as { physics: { simulatePlayer(s: unknown, w: unknown): unknown } }).physics;
  const state = new playerStateCtor(bot, {
    forward: true,
    back: false,
    left: false,
    right: false,
    jump: true,
    sprint: true,
    sneak: false
  }) as unknown as { pos: { x: number; y: number; z: number }; yaw: number; onGround: boolean };
  const p = bot.entity.position;
  state.yaw = Math.atan2(-(rung.x + 0.5 - p.x), -(rung.z + 0.5 - p.z));
  const world = { getBlock: (pos: ReturnType<typeof v3>) => bot.blockAt(pos, false) };
  const y0 = p.y;
  for (let t = 0; t < 14; t++) {
    physics.simulatePlayer(state, world);
    const fx = Math.floor(state.pos.x);
    const fy = Math.floor(state.pos.y);
    const fz = Math.floor(state.pos.z);
    if (fx === rung.x && fz === rung.z && fy === rung.y) return true;
    if (state.pos.y < y0 - 1) return false;
  }
  return false;
}

type CellInfo = { climbable?: boolean; safe?: boolean; physical?: boolean };

/**
 * Top rung → onto the block beside it, one up (issue #34). Pathfinder only climbs
 * straight up a column, so a ladder on a 1-block wall with nothing behind it had
 * no way off: the bot bobbed on the last rung forever. The exit is usually the
 * block the ladder hangs on.
 */
function addLadderTopExits(
  m: { getBlock: (node: PathNode, dx: number, dy: number, dz: number) => CellInfo },
  node: PathNode,
  neighbors: unknown[],
  Move: new (x: number, y: number, z: number, remainingBlocks: number, cost: number, toBreak: unknown[], toPlace: unknown[], parkour?: boolean) => unknown,
  remaining: number
) {
  try {
    const above = m.getBlock(node, 0, 1, 0);
    const above2 = m.getBlock(node, 0, 2, 0);
    if (above?.climbable || !above?.safe || !above2?.safe) return; // not the top rung, or no head room
  } catch {
    return;
  }
  for (const dir of CARDINAL_XZ) {
    try {
      const floor = m.getBlock(node, dir.x, 0, dir.z);
      const feet = m.getBlock(node, dir.x, 1, dir.z);
      const head = m.getBlock(node, dir.x, 2, dir.z);
      if (!floor?.physical || !feet?.safe || !head?.safe || feet.climbable) continue;
      const exists = neighbors.some((n) => {
        const mv = n as PathNode;
        return mv.x === node.x + dir.x && mv.y === node.y + 1 && mv.z === node.z + dir.z;
      });
      if (exists) continue;
      neighbors.push(new Move(node.x + dir.x, node.y + 1, node.z + dir.z, remaining, 1.6, [], [], false));
    } catch {
      /* */
    }
  }
}

/**
 * Out of water onto a bank one block up. Pathfinder never plans a jump from water,
 * so a pool two blocks deep with a ledge at the far side had no way across: the bot
 * swam back to where it came in. Swimming up against the ledge lifts a player out.
 */
function addWaterExits(
  m: { getBlock: (node: PathNode, dx: number, dy: number, dz: number) => CellInfo & { liquid?: boolean; name?: string } },
  node: PathNode,
  neighbors: unknown[]
) {
  let inWater = false;
  try {
    const here = m.getBlock(node, 0, 0, 0);
    const up = m.getBlock(node, 0, 1, 0);
    inWater = Boolean(here?.liquid) && !String(here?.name ?? "").includes("lava") && Boolean(up?.safe) && !up?.liquid;
  } catch {
    return;
  }
  if (!inWater) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Move = require("mineflayer-pathfinder/lib/move") as new (
    x: number, y: number, z: number, remainingBlocks: number, cost: number, toBreak: unknown[], toPlace: unknown[], parkour?: boolean
  ) => unknown;
  const remaining = (node as { remainingBlocks?: number }).remainingBlocks ?? 0;
  for (const dir of CARDINAL_XZ) {
    try {
      const bank = m.getBlock(node, dir.x, 0, dir.z);
      const feet = m.getBlock(node, dir.x, 1, dir.z);
      const head = m.getBlock(node, dir.x, 2, dir.z);
      const over = m.getBlock(node, 0, 2, 0);
      if (!bank?.physical || bank.liquid || !feet?.safe || feet.liquid || !head?.safe || !over?.safe) continue;
      const exists = neighbors.some((n) => {
        const mv = n as PathNode;
        return mv.x === node.x + dir.x && mv.y === node.y + 1 && mv.z === node.z + dir.z;
      });
      if (exists) continue;
      neighbors.push(new Move(node.x + dir.x, node.y + 1, node.z + dir.z, remaining, 2.5, [], [], false));
    } catch {
      /* */
    }
  }
}

/** Yatay boşluk blok sayısı (ayak noktaları arası - 1) */
export function measureGapBlocks(
  from: { x: number; z: number },
  to: { x: number; z: number }
): number {
  const dx = Math.abs(Math.floor(to.x) - Math.floor(from.x));
  const dz = Math.abs(Math.floor(to.z) - Math.floor(from.z));
  // chebyshev-ish: max eksen farkı - 1 = boşluktaki air sayısı yaklaşık
  return Math.max(dx, dz);
}

type GapLanding = { x: number; y: number; z: number; gap: number; score: number };

function scanGapAlongStep(
  bot: Bot,
  origin: { x: number; y: number; z: number },
  step: { dx: number; dz: number },
  maxGap: number,
  goal: { x: number; y: number; z: number }
): GapLanding | null {
  if (step.dx === 0 && step.dz === 0) return null;
  const px = Math.floor(origin.x);
  const py = Math.floor(origin.y);
  const pz = Math.floor(origin.z);
  let gapStart = 0;
  let best: GapLanding | null = null;

  for (let d = 1; d <= 13; d++) {
    const cx = px + step.dx * d;
    const cz = pz + step.dz * d;
    if (isOpenableCell(bot, cx, py, cz)) return best;
    // Landing may be several blocks BELOW takeoff (downward sprint). Do not require same Y.
    const sy = standYAt(bot, cx, py, cz);
    if (sy === null) {
      if (gapStart === 0) {
        if (d > 3) break;
        gapStart = d;
      }
      continue;
    }
    if (gapStart === 0) continue;
    const airBlocks = d - gapStart;
    const drop = py - sy;
    // Only the first cell past the gap is a landing: cells after it are the far pad,
    // and counting them as air turned a 3-gap into a "4-gap" to a farther cell.
    if (drop > maxSafeDrop(bot)) return best;
    const maxAir = maxAirForDrop(drop, maxGap);
    // a 1-block gap is a walk-across at the same height, but a hop when it drops
    if ((airBlocks < 2 && drop < 1) || airBlocks > maxAir) return best;

    const flyY = Math.max(py, sy);
    let blocked = false;
    for (let t = gapStart; t < d; t++) {
      const mx = px + step.dx * t;
      const mz = pz + step.dz * t;
      if (isOpenableCell(bot, mx, py, mz)) {
        blocked = true;
        break;
      }
      if (isSolid(bot, mx, flyY, mz) || isSolid(bot, mx, flyY + 1, mz)) {
        blocked = true;
        break;
      }
    }
    if (blocked) return best;

    const toGoal = Math.hypot(goal.x - (cx + 0.5), goal.y - sy, goal.z - (cz + 0.5));
    const fromHere = Math.hypot(goal.x - origin.x, goal.z - origin.z);
    if (fromHere - toGoal < 1.2) return best;
    return { x: cx, y: sy, z: cz, gap: airBlocks, score: toGoal + airBlocks * 0.08 };
  }
  return best;
}

/**
 * Landing off the straight lines (issue #34): a jump to a pad one or two blocks to
 * the side (a diagonal / corner jump) was never found, so the bot stood at the lip.
 * Checks every standable cell around, measuring the air along the actual jump line.
 */
function scanGapFan(
  bot: Bot,
  origin: { x: number; y: number; z: number },
  maxGap: number,
  goal: { x: number; y: number; z: number }
): GapLanding | null {
  const px = Math.floor(origin.x);
  const py = Math.floor(origin.y);
  const pz = Math.floor(origin.z);
  const R = maxGap + 3;
  const fromHere = Math.hypot(goal.x - origin.x, goal.z - origin.z);
  let best: GapLanding | null = null;
  for (let cx = px - R; cx <= px + R; cx++) {
    for (let cz = pz - R; cz <= pz + R; cz++) {
      if (Math.abs(cx - px) <= 1 && Math.abs(cz - pz) <= 1) continue;
      const sy = standYAt(bot, cx, py, cz, Math.min(4, maxSafeDrop(bot)));
      if (sy === null) continue;
      const drop = py - sy;
      const toGoal = Math.hypot(goal.x - (cx + 0.5), goal.y - sy, goal.z - (cz + 0.5));
      if (fromHere - toGoal < 1.2) continue;
      // walk the line: ground at takeoff height until the lip, then air, then this cell
      const tx = cx + 0.5 - origin.x;
      const tz = cz + 0.5 - origin.z;
      const len = Math.hypot(tx, tz);
      const ux = tx / len;
      const uz = tz / len;
      let lip = -1;
      let land = -1;
      let ok = true;
      for (let t = 0; t <= len; t += 0.1) {
        const x = Math.floor(origin.x + ux * t);
        const z = Math.floor(origin.z + uz * t);
        if (isOpenableCell(bot, x, py, z)) {
          ok = false;
          break;
        }
        const flyY = Math.max(py, sy);
        if (isSolid(bot, x, flyY, z) || isSolid(bot, x, flyY + 1, z)) {
          ok = false;
          break;
        }
        const ground = isSolid(bot, x, py - 1, z);
        if (land < 0 && x === cx && z === cz) land = t;
        if (land < 0 && ground) {
          if (lip >= 0 && lip < t - 0.15) {
            ok = false; // ground again before the landing: not one clean jump
            break;
          }
          lip = t;
        }
      }
      if (!ok || lip < 0 || land < 0) continue;
      const air = land - lip; // centre line; the hitbox reaches 0.3 further on both ends
      const edge = air - 0.6;
      const limit = drop >= 1 ? maxAirForDrop(drop, maxGap) : sy > py ? Math.min(maxGap, 3) : maxGap;
      if (edge < 1 || edge > limit + 0.2) continue;
      const gap = Math.max(2, Math.round(edge));
      const cand: GapLanding = { x: cx, y: sy, z: cz, gap, score: toGoal + edge * 0.15 };
      if (!best || cand.score < best.score) best = cand;
    }
  }
  return best;
}

/**
 * Nearby parkour landing toward the goal.
 * Same-level cap is maxGap (2–4). Downward sprint may land 5–10 blocks out.
 */
export function findGapLanding(
  bot: Bot,
  goal: { x: number; y: number; z: number },
  maxGap: number = 4
): { x: number; y: number; z: number; gap: number } | null {
  if (!bot.entity) return null;
  const pos = bot.entity.position;
  const gdx = goal.x - pos.x;
  const gdz = goal.z - pos.z;
  if (Math.hypot(gdx, gdz) < 2.4) return null;

  const sx = Math.abs(gdx) >= 0.25 ? (gdx > 0 ? 1 : -1) : 0;
  const sz = Math.abs(gdz) >= 0.25 ? (gdz > 0 ? 1 : -1) : 0;
  const steps: Array<{ dx: number; dz: number }> = [];
  if (sx) steps.push({ dx: sx, dz: 0 });
  if (sz) steps.push({ dx: 0, dz: sz });
  if (sx && sz) steps.push({ dx: sx, dz: sz });

  const origin = { x: pos.x, y: pos.y, z: pos.z };
  let best: GapLanding | null = null;
  for (const step of steps) {
    const found = scanGapAlongStep(bot, origin, step, maxGap, goal);
    if (found && (!best || found.score < best.score)) best = found;
  }

  // Odd angles: step along the unit heading in whole-block increments.
  if (!best) {
    const glen = Math.hypot(gdx, gdz) || 1;
    const found = scanGapAlongStep(
      bot,
      origin,
      { dx: Math.round(gdx / glen) || 0, dz: Math.round(gdz / glen) || 0 },
      maxGap,
      goal
    );
    if (found) best = found;
  }
  if (!best) best = scanGapFan(bot, origin, maxGap, goal);

  return best ? { x: best.x, y: best.y, z: best.z, gap: best.gap } : null;
}

/**
 * Follow goal that does not treat "standing under the player" as almost-there.
 * Ground-floor A* otherwise camps the house while the player is on the roof;
 * a land-connected sky platform is a longer XZ path but the correct height.
 */
export class GoalFollowAtHeight extends goals.Goal {
  entity: Entity;
  rangeSq: number;
  x: number;
  y: number;
  z: number;

  constructor(entity: Entity, range: number) {
    super();
    this.entity = entity;
    this.rangeSq = range * range;
    const p = entity.position;
    this.x = Math.floor(p.x);
    this.y = Math.floor(p.y);
    this.z = Math.floor(p.z);
  }

  heuristic(node: PathNode): number {
    const dx = this.x - node.x;
    const dy = this.y - node.y;
    const dz = this.z - node.z;
    const xz = Math.hypot(dx, dz);
    // Keep XZ as the main cost so unused long sky roads lose to a normal walk.
    // Only punish actually standing under a high target (roof camp).
    if (dy > 2.2 && xz < 5) return xz + dy * 1.6 + (5 - xz) * 3;
    return xz + Math.abs(dy);
  }

  isEnd(node: PathNode): boolean {
    const dx = this.x - node.x;
    const dy = this.y - node.y;
    const dz = this.z - node.z;
    if (Math.abs(dy) > 1.7) return false;
    return dx * dx + dy * dy + dz * dz <= this.rangeSq;
  }

  hasChanged(): boolean {
    const p = this.entity.position.floored();
    const dx = this.x - p.x;
    const dz = this.z - p.z;
    const dy = Math.abs(this.y - p.y);
    // Ignore jump-bob and small steps so a long detour is not aborted.
    if (dx * dx + dz * dz > 16 || dy > 2.2) {
      this.x = p.x;
      this.y = p.y;
      this.z = p.z;
      return true;
    }
    return false;
  }

  isValid(): boolean {
    return this.entity != null;
  }
}

export type ObservedJump = {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  at: number;
};

export function pushObservedJump(
  list: ObservedJump[],
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number }
): void {
  const dxz = Math.hypot(to.x - from.x, to.z - from.z);
  if (dxz < 1.7) return;
  list.push({
    from: { x: from.x, y: from.y, z: from.z },
    to: { x: to.x, y: to.y, z: to.z },
    at: Date.now()
  });
  while (list.length > 8) list.shift();
}

export function pruneObservedJumps(list: ObservedJump[], maxAgeMs = 45_000): void {
  const t0 = Date.now();
  while (list.length && t0 - list[0]!.at > maxAgeMs) list.shift();
}

/** If we are standing on a takeoff the player already used, copy that jump. */
export function findReplayJump(bot: Bot, list: ObservedJump[]): ObservedJump | null {
  if (!bot.entity?.onGround) return null;
  if (isNearOpenable(bot)) return null;
  const p = bot.entity.position;
  let best: ObservedJump | null = null;
  let bestD = 1.75;
  const now = Date.now();
  for (const jump of list) {
    if (now - jump.at > 45_000) continue;
    const dFrom = Math.hypot(p.x - jump.from.x, p.z - jump.from.z);
    if (dFrom > bestD || Math.abs(p.y - jump.from.y) > 1.3) continue;
    const dTo = Math.hypot(p.x - jump.to.x, p.z - jump.to.z);
    if (dTo <= dFrom + 0.2) continue;
    const lx = Math.floor(jump.to.x);
    const ly = Math.floor(jump.to.y);
    const lz = Math.floor(jump.to.z);
    if (standYAt(bot, lx, ly, lz) == null && !isPlatformStand(bot, lx, ly, lz)) continue;
    best = jump;
    bestD = dFrom;
  }
  return best;
}

/**
 * Connected platform at the player's height, on the land side — not the isolated roof
 * the player is standing on, and not the ground under them.
 */
export function findElevatedApproach(
  bot: Bot,
  goal: { x: number; y: number; z: number },
  radius = 24
): { x: number; y: number; z: number } | null {
  if (!bot.entity) return null;
  const py = Math.floor(goal.y);
  const bx = bot.entity.position.x;
  const bz = bot.entity.position.z;
  const distGoal = Math.hypot(goal.x - bx, goal.z - bz);
  // Far away: let pathfinder pick the normal walk. Only kick in when we are
  // already under/beside the high target.
  if (distGoal > 14) return null;
  const reach = Math.min(radius, Math.max(6, Math.ceil(distGoal + 4)));
  let best: { x: number; y: number; z: number; score: number } | null = null;
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      if (dx * dx + dz * dz > reach * reach) continue;
      const x = Math.floor(goal.x) + dx;
      const z = Math.floor(goal.z) + dz;
      for (const y of [py, py - 1]) {
        if (!isPlatformStand(bot, x, y, z)) continue;
        let n = 0;
        if (isPlatformStand(bot, x + 1, y, z)) n++;
        if (isPlatformStand(bot, x - 1, y, z)) n++;
        if (isPlatformStand(bot, x, y, z + 1)) n++;
        if (isPlatformStand(bot, x, y, z - 1)) n++;
        const distP = Math.hypot(x + 0.5 - goal.x, z + 0.5 - goal.z);
        const distB = Math.hypot(x + 0.5 - bx, z + 0.5 - bz);
        if (distP < 2.3 && n <= 2) continue;
        if (n < 2 || distP > 10) continue;
        if (distB > distGoal + 8) continue;
        const score = distP * 0.35 + distB * 0.65 - n * 0.4;
        if (!best || score < best.score) best = { x, y, z, score };
      }
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

/**
 * Back up from the lip so a 3–4 block sprint jump has room to accelerate.
 * Sneak while reversing so we don't fall off the far side.
 */
async function prepareRunUp(
  bot: Bot,
  dir: { ux: number; uz: number },
  gap: number,
  token: TaskToken
): Promise<void> {
  if (gap < 3 || !bot.entity) return;
  const need = gap >= 6 ? 3.2 : gap >= 4 ? 2.6 : 1.8;
  const edge = distToFrontEdge(bot, dir.ux, dir.uz);
  const backDist = need - Math.min(edge, need);
  if (backDist < 0.45) return;

  const pos = bot.entity.position;
  const py = Math.floor(pos.y);
  const bx = pos.x - dir.ux * backDist;
  const bz = pos.z - dir.uz * backDist;
  if (standYAt(bot, Math.floor(bx), py, Math.floor(bz)) === null) return;

  bot.setControlState("sprint", false);
  bot.setControlState("jump", false);
  bot.setControlState("sneak", true);
  await alignManualLookAt(bot, v3(bx, pos.y + 0.4, bz));
  bot.setControlState("forward", true);
  const t0 = Date.now();
  while (Date.now() - t0 < 750 && !token.cancelled && bot.entity) {
    const p = bot.entity.position;
    if (Math.hypot(p.x - bx, p.z - bz) < 0.38) break;
    if (distToFrontEdge(bot, -dir.ux, -dir.uz) < 0.18) break;
    await sleep(20);
  }
  clearControls(bot);
  await sleep(40);
}

/**
 * Sprint toward the committed landing and jump on the last half of the takeoff block.
 * Jumping at 0.16 is too late at sprint speed — we skip the window and walk off.
 */
async function sprintJumpAtEdge(
  bot: Bot,
  dir: { ux: number; uz: number },
  gap: number,
  token: TaskToken,
  sprint = true
): Promise<void> {
  const maxTicks = Math.ceil((400 + gap * 220) / 50) + 6;
  // Where the last tick on the lip falls depends on where the run starts: from one
  // spot it is 0.01 past the support edge, from another 0.16, and a 4-gap needs the
  // far one. Shift the start back a little (sneaking, before the run) so it lands at
  // the far end. Sprint is not toggled during the run: anti-cheats flag that.
  if (gap >= 3) {
    try {
      for (let round = 0; round < 3 && !token.cancelled; round++) {
      const shift = planBackShift(bot, dir);
      if (shift < 0.05) break;
      await sneakBack(bot, dir, shift, token);
      }
    } catch {
      /* run from here */
    }
  }
  bot.setControlState("sneak", false);
  bot.setControlState("back", false);
  bot.setControlState("forward", false);
  // Stand up before sprinting. Releasing sneak and starting the sprint in the same
  // tick made GrimAC (1.21.11) set the bot back every tick: it stood at the lip and
  // never ran. A player also takes a few ticks between the two.
  await waitTicks(bot, 3);
  // Start the run on the ground: a bot still settling from a step or a landing was
  // read as "walked off already" and never jumped.
  // A setback during the run (an anti-cheat rejected a step) is followed by more of
  // them while the bot keeps pushing: stop, let it settle, run again (twice at most).
  let gaveUp = false;
  for (let attempt = 0; ; attempt++) {
  for (let i = 0; i < 10 && bot.entity && !bot.entity.onGround && !token.cancelled; i++) await waitTicks(bot, 1);
  const runStart = bot.entity.position.clone();
  bot.setControlState("forward", true);
  bot.setControlState("sprint", sprint);
  bot.setControlState("jump", false);
  let setback = false;
  let aborted = false;
  const onSetback = () => {
    setback = true;
  };
  bot.on("forcedMove", onSetback);

  // Tick-exact takeoff (issue #34): jump on the last tick the hitbox still stands on
  // the lip. A wall-clock poll jumped ~0.6 block early and a 4-gap fell short.
  await new Promise<void>((resolve) => {
    let ticks = 0;
    const done = () => {
      bot.removeListener("physicsTick", onTick);
      clearTimeout(safety);
      resolve();
    };
    const onTick = () => {
      ticks++;
      if (token.cancelled || !bot.entity) return done();
      if (setback && bot.entity.onGround) {
        aborted = true;
        return done();
      }
      if (!bot.entity.onGround) {
        const ran = (bot.entity.position.x - runStart.x) * dir.ux + (bot.entity.position.z - runStart.z) * dir.uz;
        // walked off already: the air phase takes over (a bump in place is not that)
        if (ticks > 2 && (ran > 0.6 || ticks > 12)) return done();
        return;
      }
      let leave: boolean;
      try {
        leave = wouldLeaveGroundNextTick(bot, sprint);
      } catch {
        leave = distToFrontEdge(bot, dir.ux, dir.uz) <= 0.3;
      }
      if (leave || ticks >= maxTicks) {
        bot.setControlState("jump", true);
        done();
      }
    };
    const safety = setTimeout(done, maxTicks * 50 + 1500);
    bot.on("physicsTick", onTick);
  });
  bot.removeListener("forcedMove", onSetback);
  if (aborted && (attempt >= 2 || token.cancelled)) gaveUp = true;
  if (!aborted || attempt >= 2 || token.cancelled) break;
  bot.setControlState("forward", false);
  bot.setControlState("sprint", false);
  await waitTicks(bot, 12);
  }
  if (gaveUp) {
    clearControls(bot);
    return;
  }
  // keep jump held until a tick actually lifts us
  for (let i = 0; i < 3 && bot.entity?.onGround && !token.cancelled; i++) {
    bot.setControlState("jump", true);
    await waitTicks(bot, 1);
  }
  await waitTicks(bot, 1);
  try {
    bot.setControlState("jump", false);
  } catch {
    /* */
  }
}

type PlayerStateCtor = new (bot: Bot, control: Record<string, boolean>) => { onGround: boolean };
let playerStateCtor: PlayerStateCtor | null = null;
/** Simulate one tick of sprinting forward without jumping: do we lose the ground? */
function wouldLeaveGroundNextTick(bot: Bot, sprint = true): boolean {
  if (!playerStateCtor) {
    // the same prismarine-physics copy mineflayer runs
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    playerStateCtor = (require(require.resolve("prismarine-physics", { paths: [require.resolve("mineflayer")] })) as {
      PlayerState: PlayerStateCtor;
    }).PlayerState;
  }
  const physics = (bot as unknown as { physics: { simulatePlayer(s: unknown, w: unknown): unknown } }).physics;
  const state = new playerStateCtor(bot, {
    forward: true,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint,
    sneak: false
  });
  physics.simulatePlayer(state, { getBlock: (p: ReturnType<typeof v3>) => bot.blockAt(p, false) });
  return !state.onGround;
}

/** Sprint-run from `shift` blocks behind here: how far along `dir` is the last tick on the ground? */
function lastGroundReach(bot: Bot, dir: { ux: number; uz: number }, shift: number): number | null {
  if (!playerStateCtor) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    playerStateCtor = (require(require.resolve("prismarine-physics", { paths: [require.resolve("mineflayer")] })) as {
      PlayerState: PlayerStateCtor;
    }).PlayerState;
  }
  const physics = (bot as unknown as { physics: { simulatePlayer(s: unknown, w: unknown): unknown } }).physics;
  const world = { getBlock: (p: ReturnType<typeof v3>) => bot.blockAt(p, false) };
  const p0 = bot.entity.position;
  const state = new playerStateCtor(bot, {
    forward: true,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: true,
    sneak: false
  }) as unknown as { pos: { x: number; y: number; z: number }; vel: { x: number; z: number }; onGround: boolean };
  state.pos.x -= dir.ux * shift;
  state.pos.z -= dir.uz * shift;
  state.vel.x = 0;
  state.vel.z = 0;
  let last: { x: number; z: number } | null = null;
  let step = 0;
  for (let t = 0; t < 60; t++) {
    const before = { x: state.pos.x, z: state.pos.z };
    physics.simulatePlayer(state, world);
    if (!state.onGround) break;
    step = Math.hypot(state.pos.x - before.x, state.pos.z - before.z);
    last = { x: state.pos.x, z: state.pos.z };
  }
  if (!last || step < 0.26) return null; // must leave the lip at full sprint speed
  return (last.x - p0.x) * dir.ux + (last.z - p0.z) * dir.uz;
}

/**
 * How far to step back before the run so the last tick on the lip is as far out as
 * possible (searched in 0.02 steps over one sprint stride). 0 when here is best.
 */
export function planBackShift(bot: Bot, dir: { ux: number; uz: number }): number {
  const here = lastGroundReach(bot, dir, 0);
  let best = { shift: 0, reach: here ?? -Infinity };
  // a sneak step cannot move less than ~0.05, so search what it can actually do
  for (let shift = 0.06; shift <= 0.3401; shift += 0.02) {
    const r = lastGroundReach(bot, dir, shift);
    if (r !== null && r > best.reach + 0.02) best = { shift, reach: r };
  }
  return best.shift;
}

/** Sneak straight back (still facing the jump) by about `dist` blocks. */
async function sneakBack(bot: Bot, dir: { ux: number; uz: number }, dist: number, token: TaskToken): Promise<void> {
  const p0 = bot.entity.position.clone();
  bot.setControlState("sprint", false);
  bot.setControlState("forward", false);
  bot.setControlState("sneak", true);
  bot.setControlState("back", true);
  for (let t = 0; t < 30 && !token.cancelled && bot.entity; t++) {
    await waitTicks(bot, 1);
    const p = bot.entity.position;
    const moved = -((p.x - p0.x) * dir.ux + (p.z - p0.z) * dir.uz);
    if (moved >= dist - 0.015) break;
    if (distToFrontEdge(bot, -dir.ux, -dir.uz) < 0.2) break;
  }
  bot.setControlState("back", false);
  // let the sneak step come to rest so the run starts from standstill
  for (let t = 0; t < 6 && bot.entity && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) > 0.003; t++) {
    await waitTicks(bot, 1);
  }
  bot.setControlState("sneak", false);
}

/**
 * Rehearse the jump in prismarine-physics before taking it: run from here, jump on
 * the last tick on the lip, keep forward in the air and brake over a narrow or lower
 * landing. A jump under a low ceiling or past a 1x1 pillar was taken blind and the
 * bot fell (issue #34). Returns whether it lands, and how far short it fell if not.
 */
export function rehearseGapJump(
  bot: Bot,
  landing: { x: number; y: number; z: number },
  sprint: boolean,
  brake: boolean
): { lands: boolean; short: number } {
  if (!playerStateCtor) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    playerStateCtor = (require(require.resolve("prismarine-physics", { paths: [require.resolve("mineflayer")] })) as {
      PlayerState: PlayerStateCtor;
    }).PlayerState;
  }
  const physics = (bot as unknown as { physics: { simulatePlayer(s: unknown, w: unknown): unknown } }).physics;
  const world = { getBlock: (p: ReturnType<typeof v3>) => bot.blockAt(p, false) };
  const p0 = bot.entity.position;
  const lx = landing.x + 0.5;
  const lz = landing.z + 0.5;
  const len = Math.hypot(lx - p0.x, lz - p0.z) || 1;
  const ux = (lx - p0.x) / len;
  const uz = (lz - p0.z) / len;
  const landProj = lx * ux + lz * uz;
  const make = () => {
    const st = new playerStateCtor!(bot, { forward: true, back: false, left: false, right: false, jump: false, sprint, sneak: false }) as unknown as {
      pos: { x: number; y: number; z: number };
      vel: { x: number; y: number; z: number };
      onGround: boolean;
      yaw: number;
      control: Record<string, boolean>;
      jumpTicks: number;
      jumpQueued: boolean;
    };
    st.vel.x = 0;
    st.vel.z = 0;
    // the real run waits a few ticks first: a jump cooldown from the last landing is gone
    st.jumpTicks = 0;
    st.jumpQueued = false;
    st.yaw = Math.atan2(-ux, -uz);
    return st;
  };
  // pass 1: the tick the bot would walk off the lip
  let leaveTick = -1;
  {
    const st = make();
    for (let t = 0; t < 60; t++) {
      physics.simulatePlayer(st, world);
      if (!st.onGround) {
        leaveTick = t;
        break;
      }
    }
  }
  if (leaveTick < 0) return { lands: false, short: 9 };
  // pass 2: jump on the last ground tick, then fly it out
  const st = make();
  let airborne = false;
  let airTicks = 0;
  let braking = false;
  for (let t = 0; t < 100; t++) {
    st.control.jump = t === leaveTick;
    if (airborne) airTicks++;
    // the real air loop holds jump ~4 ticks before it may brake
    if (airborne && brake && airTicks > 4) {
      const proj = st.pos.x * ux + st.pos.z * uz;
      if (!braking && proj > landProj - 0.35 && st.pos.y > landing.y + 0.05) {
        braking = true;
        st.control.forward = false;
        st.control.sprint = false;
      }
      if (braking) st.control.back = proj > landProj + 0.05;
    }
    physics.simulatePlayer(st, world);
    if (!st.onGround) airborne = true;
    if (airborne && st.onGround) {
      const fx = Math.floor(st.pos.x);
      const fz = Math.floor(st.pos.z);
      const onLanding = Math.abs(st.pos.y - landing.y) < 0.6;
      const past = st.pos.x * ux + st.pos.z * uz >= landProj - 0.8;
      if (onLanding && (fx === landing.x && fz === landing.z ? true : past)) return { lands: true, short: 0 };
      return { lands: false, short: Math.max(0, landProj - 0.5 - (st.pos.x * ux + st.pos.z * uz)) };
    }
    if (st.pos.y < landing.y - 2) {
      return { lands: false, short: Math.max(0, landProj - 0.5 - (st.pos.x * ux + st.pos.z * uz)) };
    }
  }
  return { lands: false, short: 9 };
}

/**
 * Sprint jump: run-up + hold jump until airborne. Used only for long / down gaps.
 * Once airborne, look and controls stay on the landing — no retarget.
 */
export async function executeGapJump(
  instance: BotInstance,
  landing: { x: number; y: number; z: number },
  gap: number,
  token: TaskToken,
  report?: ProgressFn
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return false;
  const ownsLock = !parkourLocks.has(bot);
  if (ownsLock) parkourLocks.add(bot);

  const g = Math.min(10, Math.max(1, Math.round(gap)));
  report?.({ done: 0, total: 1, label: `parkur ${g} blok atlama → ${landing.x},${landing.y},${landing.z}` });
  try {
    await handoffToManualControl(bot);
    // plan from the ground: a bot still in the air (a jump already under way) has no lip
    for (let i = 0; i < 20 && bot.entity && !bot.entity.onGround && !token.cancelled; i++) await waitTicks(bot, 1);
    if (!bot.entity?.onGround) return false;

    const lx = landing.x + 0.5;
    const ly = landing.y;
    const lz = landing.z + 0.5;
    const pos0 = bot.entity.position;
    const drop = Math.max(0, pos0.y - ly);
    const dx = lx - pos0.x;
    const dz = lz - pos0.z;
    const len = Math.hypot(dx, dz) || 1;
    const dir = { ux: dx / len, uz: dz / len };

    // past the near edge of the landing cell, measured from the takeoff side
    const startProj = pos0.x * dir.ux + pos0.z * dir.uz;
    const landProj = lx * dir.ux + lz * dir.uz;
    const crossed = (p: { x: number; z: number }) => p.x * dir.ux + p.z * dir.uz >= landProj - 0.8 && landProj > startProj;
    // A short hop down onto a beam: a sprint jump flew right over it (issue #34).
    const gentle = drop >= 1.5 && g <= 2;
    await prepareRunUp(bot, dir, g, token);
    if (token.cancelled) {
      clearControls(bot);
      throw new Error(token.reason ?? "cancelled");
    }

    // Look toward landing XZ at takeoff eye height — staring down kills sprint distance.
    await alignManualLookAt(bot, v3(lx, pos0.y + 0.3, lz));
    // brake over a landing with nothing behind it (a pillar, a beam end) or below us
    const narrow = !isPlatformStand(bot, landing.x + Math.round(dir.ux), landing.y, landing.z + Math.round(dir.uz));
    const brake = drop >= 1 || narrow;
    // onto a 1x1 or a beam end a walking jump is enough and much easier to stop
    let sprintMode = !(gentle || (narrow && g <= 2));
    let plan = rehearseGapJump(bot, landing, sprintMode, brake);
    if (!plan.lands) {
      const other = rehearseGapJump(bot, landing, !sprintMode, brake);
      if (other.lands) {
        sprintMode = !sprintMode;
        plan = other;
      }
    }
    // A long jump a few centimetres short is fixed by the run-up shift below; anything
    // else that does not land (a ceiling, a pillar overshot) is not attempted at all.
    if (!plan.lands && !(g >= 3 && plan.short > 0 && plan.short <= 0.45)) {
      clearControls(bot);
      const bp = bot.entity.position;
      instance.getLogger().debug("Parkour jump skipped", `would not land (gap=${g} short=${plan.short.toFixed(2)} from ${bp.x.toFixed(2)},${bp.y.toFixed(2)},${bp.z.toFixed(2)} v=${bot.entity.velocity.x.toFixed(2)},${bot.entity.velocity.z.toFixed(2)} → ${landing.x},${landing.y},${landing.z} sprint=${sprintMode})`);
      return false;
    }
    await sprintJumpAtEdge(bot, dir, g, token, sprintMode);
    {
      const tp = bot.entity.position;
      const tv = bot.entity.velocity;
      instance.getLogger().debug("Parkour takeoff", `at ${tp.x.toFixed(2)},${tp.y.toFixed(2)},${tp.z.toFixed(2)} v=${Math.hypot(tv.x, tv.z).toFixed(3)} vy=${tv.y.toFixed(2)} sprint=${bot.getControlState("sprint")} yaw=${bot.entity.yaw.toFixed(2)} want=${Math.atan2(-(lx - tp.x), -(lz - tp.z)).toFixed(2)} toLand=${Math.hypot(lx - tp.x, lz - tp.z).toFixed(2)}`);
    }
    if (token.cancelled) {
      clearControls(bot);
      throw new Error(token.reason ?? "cancelled");
    }

    bot.setControlState("forward", true);
    bot.setControlState("sprint", sprintMode);
    let braking = false;
    const airDeadline = Date.now() + 800 + g * 160 + drop * 90;
    const jumpHoldUntil = Date.now() + 220;
    let fellPast = false;
    while (Date.now() < airDeadline && !token.cancelled) {
      const ent = bot.entity;
      if (!ent) break;
      if (Date.now() < jumpHoldUntil) {
        try {
          bot.setControlState("jump", true);
        } catch {
          /* */
        }
      }
      const pos = ent.position;
      const vy = ent.velocity?.y ?? 0;
      if (pos.y < ly - 2.2 && vy < -0.35) {
        fellPast = true;
        clearControls(bot);
        break;
      }
      // Dropping onto the landing: let go of forward once over it, and pull back if
      // still drifting past (what a player does landing on a narrow beam below).
      if (!ent.onGround && brake && Date.now() > jumpHoldUntil && pos.y > ly + 0.05) {
        const proj = pos.x * dir.ux + pos.z * dir.uz;
        if (!braking && proj > landProj - 0.35) {
          braking = true;
          bot.setControlState("forward", false);
          bot.setControlState("sprint", false);
        }
        if (braking) bot.setControlState("back", proj > landProj + 0.05);
      }
      const d = Math.hypot(pos.x - lx, pos.z - lz);
      if (ent.onGround && d < 2.1 && Math.abs(pos.y - ly) < Math.max(1.8, drop + 1)) break;
      // touched down on the far side at the landing height: stop running on
      if (ent.onGround && Date.now() > jumpHoldUntil && crossed(pos) && Math.abs(pos.y - ly) < 0.6) break;
      if (ent.onGround && Date.now() > airDeadline - 400) break;
      await sleep(30);
    }

    clearControls(bot);
    if (fellPast) {
      instance.getLogger().info("Parkour jump", "landing missed — abandoned to MLG");
      await yieldFallToMlg(instance, bot, token);
      return false;
    }
    await sleep(60);
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");

    const pos = bot.entity.position;
    const landed =
      Boolean(bot.entity.onGround) &&
      (Math.hypot(pos.x - lx, pos.z - lz) < 2.2 || crossed(pos)) &&
      Math.abs(pos.y - ly) < Math.max(1.8, drop + 1.2);

    if (landed) {
      report?.({ done: 1, total: 1, label: `parkur ${g} OK` });
      instance.getLogger().info(`Parkour jump succeeded`, `${g} blok → ${landing.x},${landing.y},${landing.z}`);
    } else {
      instance.getLogger().debug("Parkour jump weak landing", `gap=${g} d=${Math.hypot(pos.x - lx, pos.z - lz).toFixed(1)}`);
    }
    return landed;
  } finally {
    if (ownsLock) parkourLocks.delete(bot);
  }
}

async function waitTargetStable(
  getPos: () => { x: number; y: number; z: number },
  token: TaskToken,
  stableMs = 550,
  timeoutMs = 2000
): Promise<{ x: number; y: number; z: number }> {
  // XZ only — ignore jump bobbing on the far platform.
  const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
  let last = { ...getPos() };
  let stillSince = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && !token.cancelled) {
    const p = getPos();
    if (horiz(p, last) > 0.45) {
      last = { x: p.x, y: p.y, z: p.z };
      stillSince = Date.now();
    } else if (Date.now() - stillSince >= stableMs) {
      return { x: p.x, y: p.y, z: p.z };
    }
    await sleep(50);
  }
  const p = getPos();
  return { x: p.x, y: p.y, z: p.z };
}

/** Follow/goto: wait until the target stops jittering, then one locked sprint-jump. */
export async function tryCommittedGapJumpToward(
  instance: BotInstance,
  target: { position: { x: number; y: number; z: number } },
  token: TaskToken,
  report?: ProgressFn
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return false;
  if (parkourLocks.has(bot)) return false;
  const cfg = parkourFromMovement(instance.config.movement);
  if (!cfg.enabled) return false;

  const botY = bot.entity.position.y;
  // Player above us: do not invent an up-jump into the void under a roof.
  if (target.position.y - botY > 2.2) return false;
  if (isNearOpenable(bot)) return false;
  const preview = findGapLanding(bot, target.position, 10);
  if (!preview || !isLongSprintGap(preview, botY)) return false;

  parkourLocks.add(bot);
  try {
    await handoffToManualControl(bot, 80);
    if (token.cancelled) return false;

    report?.({ done: 0, total: 1, label: "parkur: hedef dursun" });
    const aim = await waitTargetStable(() => {
      const p = target.position;
      return { x: p.x, y: p.y, z: p.z };
    }, token);
    if (token.cancelled) return false;
    const land = findGapLanding(bot, aim, 10) ?? preview;
    if (!isLongSprintGap(land, bot.entity.position.y)) return false;
    instance.getLogger().info("Committed gap jump", `gap=${land.gap} drop≈${(botY - land.y).toFixed(0)} → ${land.x},${land.y},${land.z}`);
    return await executeGapJump(instance, land, land.gap, token, report);
  } finally {
    parkourLocks.delete(bot);
  }
}

/** Last cell of this platform, walking from the bot straight toward the target. */
function findLipToward(bot: Bot, target: { x: number; z: number }): { x: number; y: number; z: number } | null {
  if (!bot.entity) return null;
  const pos = bot.entity.position;
  const px = Math.floor(pos.x);
  const py = Math.floor(pos.y);
  const pz = Math.floor(pos.z);
  const gdx = target.x - pos.x;
  const gdz = target.z - pos.z;
  const steps: Array<{ dx: number; dz: number }> = [];
  const sx = Math.abs(gdx) >= 0.5 ? Math.sign(gdx) : 0;
  const sz = Math.abs(gdz) >= 0.5 ? Math.sign(gdz) : 0;
  if (Math.abs(gdx) >= Math.abs(gdz)) {
    if (sx) steps.push({ dx: sx, dz: 0 });
    if (sz) steps.push({ dx: 0, dz: sz });
  } else {
    if (sz) steps.push({ dx: 0, dz: sz });
    if (sx) steps.push({ dx: sx, dz: 0 });
  }
  let best: { x: number; y: number; z: number; score: number } | null = null;
  for (const step of steps) {
    let last: { x: number; z: number } | null = null;
    for (let d = 1; d <= 24; d++) {
      const cx = px + step.dx * d;
      const cz = pz + step.dz * d;
      if (isOpenableCell(bot, cx, py, cz) || !isPlatformStand(bot, cx, py, cz)) break;
      last = { x: cx, z: cz };
    }
    if (!last) continue;
    // the lip must face an actual hole, not a wall
    const nx = last.x + step.dx;
    const nz = last.z + step.dz;
    if (isSolid(bot, nx, py, nz) || isSolid(bot, nx, py + 1, nz)) continue;
    const score = Math.hypot(target.x - (last.x + 0.5), target.z - (last.z + 0.5));
    if (!best || score < best.score) best = { x: last.x, y: py, z: last.z, score };
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

/**
 * goto fallback when A* has no path (issue #34): pathfinder's own parkour stops at
 * 3-block gaps, so a 4-gap target was "noPath". Walk to the lip facing the target
 * and take one configured sprint jump. `walkTo` is the caller's pathfinder walk.
 */
export async function tryGapJumpTowardPoint(
  instance: BotInstance,
  target: { x: number; y: number; z: number },
  token: TaskToken,
  walkTo: (x: number, y: number, z: number) => Promise<void>,
  report?: ProgressFn
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return false;
  if (parkourLocks.has(bot)) return false;
  const cfg = parkourFromMovement(instance.config.movement);
  if (!cfg.enabled) return false;
  if (target.y - bot.entity.position.y > 1.2) return false; // no up-jumps into a roof
  if (isNearOpenable(bot)) return false;

  let land = findGapLanding(bot, target, cfg.maxGap);
  if (!land) {
    const lip = findLipToward(bot, target);
    if (!lip) return false;
    const here = bot.entity.position;
    if (Math.hypot(lip.x + 0.5 - here.x, lip.z + 0.5 - here.z) > 0.8) {
      try {
        await walkTo(lip.x, lip.y, lip.z);
      } catch {
        return false;
      }
    }
    if (token.cancelled || !bot.entity) return false;
    land = findGapLanding(bot, target, cfg.maxGap);
  }
  if (!land || !jumpIsReachable(bot.entity.position.y, land)) return false;
  {
    // Far back from the lip: walk up to it first and measure again (a long walk-up
    // run from the middle of a pad was set back by GrimAC and never left the ground).
    const here = bot.entity.position;
    const len = Math.hypot(land.x + 0.5 - here.x, land.z + 0.5 - here.z) || 1;
    const edge = distToFrontEdge(bot, (land.x + 0.5 - here.x) / len, (land.z + 0.5 - here.z) / len);
    if (edge > 1.6) {
      const lip = findLipToward(bot, { x: land.x + 0.5, z: land.z + 0.5 });
      if (lip && Math.hypot(lip.x + 0.5 - here.x, lip.z + 0.5 - here.z) > 0.8) {
        try {
          await walkTo(lip.x, lip.y, lip.z);
        } catch {
          /* jump from here */
        }
        if (token.cancelled || !bot.entity) return false;
        land = findGapLanding(bot, target, cfg.maxGap) ?? land;
      }
    }
  }
  const drop = bot.entity.position.y - land.y;
  if (drop < 1 && land.gap > cfg.maxGap) return false;
  instance.getLogger().info("Gap jump toward target", `gap=${land.gap} → ${land.x},${land.y},${land.z}`);
  return executeGapJump(instance, land, land.gap, token, report);
}

/** Copy a jump the followed player already completed. Do not invent a new line. */
export async function tryReplayObservedJump(
  instance: BotInstance,
  jump: ObservedJump,
  token: TaskToken,
  report?: ProgressFn
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return false;
  if (parkourLocks.has(bot)) return false;
  const lx = Math.floor(jump.to.x);
  const ly = standYAt(bot, lx, Math.floor(jump.to.y), Math.floor(jump.to.z)) ?? Math.floor(jump.to.y);
  const lz = Math.floor(jump.to.z);
  const gap = Math.max(
    2,
    Math.min(10, Math.round(Math.hypot(jump.to.x - jump.from.x, jump.to.z - jump.from.z)))
  );
  if (!jumpIsReachable(bot.entity.position.y, { y: ly, gap })) return false;
  instance.getLogger().info("Replay player jump", `gap≈${gap} → ${lx},${ly},${lz}`);
  return executeGapJump(instance, { x: lx, y: ly, z: lz }, gap, token, report);
}

/**
 * Player is already on the far platform. Jump there if the landing IS their
 * block — do not wander under them or invent a side jump into the void.
 */
export async function tryJumpAcrossToPlayer(
  instance: BotInstance,
  target: { position: { x: number; y: number; z: number } },
  token: TaskToken,
  report?: ProgressFn,
  opts?: { force?: boolean }
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity || instance.status !== "online") return false;
  if (parkourLocks.has(bot)) return false;
  const cfg = parkourFromMovement(instance.config.movement);
  if (!cfg.enabled) return false;
  if (isNearOpenable(bot)) return false;

  const pos = bot.entity.position;
  const tp = target.position;
  if (tp.y - pos.y > 2.2) return false;
  const xz = Math.hypot(tp.x - pos.x, tp.z - pos.z);
  if (xz < 2.05 || xz > 10.5) return false;

  const land = findGapLanding(bot, tp, 10);
  if (!land) return false;
  const nearPlayer = Math.hypot(land.x + 0.5 - tp.x, land.y - tp.y, land.z + 0.5 - tp.z);
  if (nearPlayer > 2.8) return false;
  if (!jumpIsReachable(pos.y, land)) return false;

  const dir = {
    ux: (land.x + 0.5 - pos.x) / (Math.hypot(land.x + 0.5 - pos.x, land.z + 0.5 - pos.z) || 1),
    uz: (land.z + 0.5 - pos.z) / (Math.hypot(land.x + 0.5 - pos.x, land.z + 0.5 - pos.z) || 1)
  };
  const edge = distToFrontEdge(bot, dir.ux, dir.uz);
  if (!opts?.force && edge > 2.8) return false;

  instance.getLogger().info("Jump across to player", `gap=${land.gap} → ${land.x},${land.y},${land.z}`);
  return executeGapJump(instance, land, land.gap, token, report);
}

type LadderPos = { x: number; y: number; z: number };

/** Ayak hizası merdiven (yatay ±1, dikey ±1) */
function findNearbyLadder(bot: Bot, fx: number, fy: number, fz: number): LadderPos | null {
  for (const dy of [0, 1, -1]) {
    for (const dx of [0, 1, -1]) {
      for (const dz of [0, 1, -1]) {
        if (isLadder(bot, fx + dx, fy + dy, fz + dz)) {
          return { x: fx + dx, y: fy + dy, z: fz + dz };
        }
      }
    }
  }
  return null;
}

/** Sütun: ayaktaki merdivenden yukarı en üst merdiven Y (+1 stand) */
function ladderColumnTopY(bot: Bot, lx: number, ly: number, lz: number, maxUp = 48): number {
  let y = ly;
  for (let i = 0; i < maxUp; i++) {
    if (isLadder(bot, lx, y + 1, lz)) y++;
    else break;
  }
  // tepedeki merdiven bloğunun üstü stand noktası
  return y + 1;
}

function stillOnLadder(bot: Bot): boolean {
  if (!bot.entity) return false;
  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);
  return isLadder(bot, fx, fy, fz) || isLadder(bot, fx, fy + 1, fz) || isLadder(bot, fx, Math.floor(p.y - 0.15), fz);
}

/** facing = merdivenin baktığı yön; duvar = tersi. Duvara doğru birim vektör. */
function ladderIntoWall(bot: Bot, lx: number, ly: number, lz: number): { x: number; z: number; yaw: number } {
  const b = bot.blockAt(v3(lx, ly, lz));
  let face = "";
  try {
    const props = (b as { getProperties?: () => Record<string, unknown> })?.getProperties?.();
    face = String(props?.facing ?? "").toLowerCase();
  } catch {
    /* */
  }
  // facing north = merdiven güneye bakıyor? MC: ladder facing = direction of the open side (player stands).
  // Oyuncu facing yönünde merdivene bakarak forward basar.
  if (face === "north") return { x: 0, z: -1, yaw: Math.PI }; // look north
  if (face === "south") return { x: 0, z: 1, yaw: 0 };
  if (face === "west") return { x: -1, z: 0, yaw: Math.PI / 2 };
  if (face === "east") return { x: 1, z: 0, yaw: -Math.PI / 2 };
  // bilinmiyor — merdiven merkezine bak
  return { x: 0, z: 0, yaw: bot.entity?.yaw ?? 0 };
}

/**
 * Düşüş: kontrol drop, MLG'ye drop, lookAt yok.
 */
async function yieldFallToMlg(
  instance: BotInstance,
  bot: Bot,
  token: TaskToken,
  maxMs = 5500
): Promise<void> {
  clearControls(bot);
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }
  const t0 = Date.now();
  let sawMlg = false;
  while (!token.cancelled && Date.now() - t0 < maxMs) {
    if (!bot.entity) break;
    const vy = bot.entity.velocity?.y ?? 0;
    clearControls(bot);
    const fg = instance.survival?.getFallGuardState?.();
    if (fg?.active || (fg?.falling && fg.method)) {
      sawMlg = true;
      await sleep(40);
      continue;
    }
    if (bot.entity.onGround && Math.abs(vy) < 0.12) {
      if (sawMlg) await sleep(120);
      break;
    }
    await sleep(40);
  }
  clearControls(bot);
  await sleep(60);
}

export type ClimbAbortFn = () => boolean;

function isAborted(token: TaskToken, shouldAbort?: ClimbAbortFn): boolean {
  if (token.cancelled) return true;
  try {
    if (shouldAbort?.()) return true;
  } catch {
    /* */
  }
  return false;
}

/** Pathfinder ile merdiven üstüne çıkmayı dene — takılınca / abort'ta hemen drop */
async function climbViaPathfinder(
  instance: BotInstance,
  bot: Bot,
  top: { x: number; y: number; z: number },
  token: TaskToken,
  timeoutMs: number,
  shouldAbort?: ClimbAbortFn
): Promise<boolean> {
  ensureParkourBot(instance);
  const goal = new goals.GoalNear(top.x, top.y, top.z, 1.5);
  return new Promise((resolve) => {
    let settled = false;
    let lastY = bot.entity?.position.y ?? 0;
    let lastProgressAt = Date.now();
    const stop = () => {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
    };
    const cleanup = () => {
      clearInterval(watch);
      clearTimeout(deadline);
      bot.removeListener("goal_reached", onReached);
      bot.removeListener("path_update", onPath);
    };
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      stop();
      clearControls(bot);
      resolve(ok);
    };
    const onReached = () => done(true);
    const onPath = (r: { status: string }) => {
      if (r.status === "noPath" || r.status === "timeout") done(false);
    };
    const watch = setInterval(() => {
      if (settled) return;
      if (isAborted(token, shouldAbort)) {
        instance.getLogger().info("Ladder path cancelled", "target changed / cancelled — abandoned");
        done(false);
        return;
      }
      if (!bot.entity) {
        done(false);
        return;
      }
      const y = bot.entity.position.y;
      if (y >= top.y - 0.7) {
        done(true);
        return;
      }
      // Y ilerlemesi yok → takıldı, 14s bekleme
      if (y > lastY + 0.12) {
        lastY = y;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > 2800) {
        instance.getLogger().info("Merdiven path stuck", `${(Date.now() - lastProgressAt) / 1000}s ilerleme yok — drop`);
        done(false);
      }
    }, 150);
    const deadline = setTimeout(() => {
      const y = bot.entity?.position.y ?? 0;
      done(y >= top.y - 0.85);
    }, timeoutMs);
    bot.on("goal_reached", onReached);
    bot.on("path_update", onPath);
    try {
      bot.pathfinder.setGoal(goal);
    } catch {
      done(false);
    }
  });
}

/**
 * Manuel tırmanış (vanilla): duvara bak + forward basılı + jump basılı.
 * Pulse jump düşürür; sürekli basılı daha stabil.
 */
async function climbManualHold(
  instance: BotInstance,
  bot: Bot,
  ladder: LadderPos,
  targetY: number,
  token: TaskToken,
  report?: ProgressFn,
  shouldAbort?: ClimbAbortFn,
  maxMs = 12_000
): Promise<"ok" | "fell" | "stuck" | "abort"> {
  const wall = ladderIntoWall(bot, ladder.x, ladder.y, ladder.z);
  const startY = bot.entity!.position.y;
  let peakY = startY;
  let lastProgressY = startY;
  let lastProgressAt = Date.now();
  let reattachOnce = false;
  const t0 = Date.now();

  await handoffToManualControl(bot);

  try {
    await alignManualYaw(bot, wall.yaw, 0);
  } catch {
    await alignManualLookAt(bot, v3(ladder.x + 0.5, bot.entity!.position.y + 0.4, ladder.z + 0.5));
  }

  bot.setControlState("sprint", false);
  bot.setControlState("sneak", false);
  bot.setControlState("forward", true);
  await sleep(160);
  bot.setControlState("jump", true);

  while (!isAborted(token, shouldAbort) && Date.now() - t0 < maxMs) {
    if (!bot.entity) return "stuck";
    const p = bot.entity.position;
    if (p.y > peakY) peakY = p.y;
    if (p.y >= targetY - 0.35) {
      clearControls(bot);
      return "ok";
    }

    // target artık bu yüksekliği istemiyorsa (oyuncu indi / target değişti)
    if (shouldAbort?.()) {
      clearControls(bot);
      instance.getLogger().info("Ladder manual cancelled", "target no longer needs ladder");
      return "abort";
    }

    const vy = bot.entity.velocity?.y ?? 0;
    const drop = peakY - p.y;

    if ((vy < -0.35 && !stillOnLadder(bot)) || (drop >= 1.4 && !stillOnLadder(bot)) || (drop >= 1.8 && vy < -0.4)) {
      clearControls(bot);
      instance.getLogger().info("Fell from ladder", `peak=${peakY.toFixed(1)} y=${p.y.toFixed(1)} — MLG`);
      await yieldFallToMlg(instance, bot, token);
      return "fell";
    }
    if (bot.entity.onGround && drop >= 1.0 && !stillOnLadder(bot)) {
      clearControls(bot);
      return "fell";
    }
    // Tırmanış sırasında yaw sahibi manuel momentumdur; her tick bakış zorlanmaz.
    bot.setControlState("sprint", false);
    bot.setControlState("forward", true);
    bot.setControlState("jump", true);

    if (p.y > lastProgressY + 0.12) {
      lastProgressY = p.y;
      lastProgressAt = Date.now();
      reattachOnce = false;
    } else if (Date.now() - lastProgressAt > 2200) {
      // bir kez yeniden yapış; olmazsa hemen drop (takılı kalma yok)
      if (!reattachOnce) {
        reattachOnce = true;
        clearControls(bot);
        await sleep(100);
        if (!bot.entity) return "stuck";
        if (!stillOnLadder(bot) && bot.entity.onGround) {
          bot.setControlState("forward", true);
          await sleep(150);
        }
        await alignManualYaw(bot, wall.yaw, 0);
        bot.setControlState("forward", true);
        bot.setControlState("jump", true);
        lastProgressAt = Date.now();
      } else {
        clearControls(bot);
        instance.getLogger().info("Ladder stuck", "ilerleme yok — abandoned (targete kilit yok)");
        return "stuck";
      }
    }

    report?.({
      done: 0,
      total: 1,
      label: `merdiven y=${p.y.toFixed(1)} → ${targetY.toFixed(0)}`
    });
    await sleep(80);
  }

  clearControls(bot);
  if (isAborted(token, shouldAbort)) return "abort";
  if (bot.entity && bot.entity.position.y >= targetY - 0.5) return "ok";
  return "stuck";
}

/** Tepe çıkışı: solid komşu hücreye yürü */
async function exitLadderTop(bot: Bot): Promise<void> {
  if (!bot.entity) return;
  const fx = Math.floor(bot.entity.position.x);
  const fy = Math.floor(bot.entity.position.y);
  const fz = Math.floor(bot.entity.position.z);
  type Land = { dx: number; dz: number; score: number };
  const lands: Land[] = [];
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ] as const) {
    if (!isSolid(bot, fx + dx, fy - 1, fz + dz)) continue;
    if (!isAirish(bot, fx + dx, fy, fz + dz)) continue;
    if (!isAirish(bot, fx + dx, fy + 1, fz + dz)) continue;
    lands.push({ dx, dz, score: Math.abs(dx) + Math.abs(dz) });
  }
  lands.sort((a, b) => a.score - b.score);
  if (lands.length === 0) {
    await sleep(200);
    return;
  }
  const { dx, dz } = lands[0]!;
  clearControls(bot);
  await alignManualLookAt(bot, v3(fx + dx + 0.5, fy, fz + dz + 0.5));
  await sleep(70);
  bot.setControlState("forward", true);
  if (stillOnLadder(bot)) {
    bot.setControlState("jump", true);
    await sleep(60);
    bot.setControlState("jump", false);
  }
  await sleep(220);
  clearControls(bot);
  await sleep(100);
}

export interface ClimbLadderOpts {
  /** true → merdiveni drop (target değişti / oyuncu indi / cancelled) */
  shouldAbort?: ClimbAbortFn;
  /** pathfinder tırmanış üst süre (ms) */
  pathMs?: number;
  /** manuel tırmanış üst süre (ms) */
  manualMs?: number;
}

/**
 * Merdiven tırman:
 * 1) pathfinder  2) manuel hold  3) düşüş→MLG  4) takılınca/abort'ta hemen drop
 * shouldAbort: target oyuncu indiyse / merdiven gerekmiyorsa true dön
 */
export async function climbLadderParkour(
  instance: BotInstance,
  targetY: number,
  token: TaskToken,
  report?: ProgressFn,
  opts?: ClimbLadderOpts
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity) return false;
  // Spiral/turning: pathfinder has offset-rung neighbors. Hijack (one column +
  // exit onto a solid) pulls the bot off the parkour.
  if (isTurningLadder(bot)) return false;
  const shouldAbort = opts?.shouldAbort;
  const pathMs = opts?.pathMs ?? 7_000;
  const manualMs = opts?.manualMs ?? 10_000;

  ensureParkourBot(instance);
  clearControls(bot);
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }

  if (isAborted(token, shouldAbort)) {
    report?.({ done: 1, total: 1, label: "merdiven cancelled" });
    return false;
  }

  const p0 = bot.entity.position;
  const ladder0 = findNearbyLadder(bot, Math.floor(p0.x), Math.floor(p0.y), Math.floor(p0.z));
  if (!ladder0) {
    report?.({ done: 1, total: 1, label: "merdiven yok" });
    return false;
  }

  const colTopY = ladderColumnTopY(bot, ladder0.x, ladder0.y, ladder0.z);
  let wantY = Math.min(targetY, colTopY);
  // target zaten bu yükseklikte / altındaysa tırmanma
  if (wantY <= p0.y + 0.8) {
    report?.({ done: 1, total: 1, label: "merdiven gerekmiyor" });
    return false;
  }

  report?.({ done: 0, total: 1, label: `merdiven → y=${Math.floor(wantY)}` });
  instance.getLogger().info("Ladder climb", `column top≈${colTopY} target=${wantY.toFixed(1)}`);

  const abortClimb = () => {
    if (isAborted(token, shouldAbort)) return true;
    // canlı target Y düştüyse (shouldAbort forde de olabilir) — ekstra safek yok
    return false;
  };

  // --- A) Pathfinder ---
  const pfOk = await climbViaPathfinder(
    instance,
    bot,
    { x: ladder0.x, y: wantY, z: ladder0.z },
    token,
    pathMs,
    abortClimb
  );
  if (isAborted(token, shouldAbort)) {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: "merdiven cancelled (target)" });
    return false;
  }
  if (pfOk && bot.entity.position.y >= wantY - 0.8) {
    await exitLadderTop(bot);
    const ok = bot.entity.position.y >= wantY - 1.0;
    report?.({ done: 1, total: 1, label: ok ? "ladder OK (path)" : "ladder partial" });
    if (ok) instance.getLogger().info("Merdiven parkuru tamam", `pathfinder y=${bot.entity.position.y.toFixed(1)}`);
    return ok;
  }

  clearControls(bot);
  await sleep(80);
  if (isAborted(token, shouldAbort)) {
    report?.({ done: 1, total: 1, label: "merdiven cancelled (target)" });
    return false;
  }

  // --- B) Manuel ---
  const ladder =
    findNearbyLadder(
      bot,
      Math.floor(bot.entity.position.x),
      Math.floor(bot.entity.position.y),
      Math.floor(bot.entity.position.z)
    ) ?? ladder0;

  report?.({ done: 0, total: 1, label: `merdiven manuel → ${Math.floor(wantY)}` });
  const result = await climbManualHold(
    instance,
    bot,
    ladder,
    wantY,
    token,
    report,
    abortClimb,
    manualMs
  );

  if (result === "abort" || isAborted(token, shouldAbort)) {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: "merdiven cancelled (target)" });
    return false;
  }
  if (result === "fell" || result === "stuck") {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: result === "fell" ? "ladder fell" : "merdiven stuck — abandoned" });
    return false;
  }
  if (result !== "ok" || bot.entity.position.y < wantY - 1.0) {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: "ladder incomplete" });
    return false;
  }

  await sleep(120);
  await exitLadderTop(bot);
  const ok = bot.entity.position.y >= wantY - 1.0;
  report?.({ done: 1, total: 1, label: ok ? "ladder OK" : "ladder partial" });
  if (ok) instance.getLogger().info("Merdiven parkuru tamam", `manuel y=${bot.entity.position.y.toFixed(1)}`);
  return ok;
}

export interface ParkourGotoOpts {
  /**
   * Canlı target (oyuncu takip/goto). Her turda yenilenir.
   * null = target kayboldu → çık.
   */
  liveTarget?: () => { x: number; y: number; z: number } | null;
}

/**
 * Parkour destekli goto: pathfinder + gap jump + merdiven.
 * liveTarget varsa target hareket edince merdiven dropılır / path yenilenir.
 */
export async function runParkourGoto(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  range: number,
  token: TaskToken,
  report: ProgressFn,
  opts?: ParkourGotoOpts
): Promise<void> {
  const bot = instance.bot;
  if (!bot?.entity) throw new Error("Bot offline");
  const cfg = parkourFromMovement(instance.config.movement);

  ensureParkourBot(instance);
  report({ done: 0, total: 1, label: `parkur git → ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}` });

  let gx = x;
  let gy = y;
  let gz = z;
  let attempts = 0;
  const maxAttempts = 8;
  let ladderCooldownUntil = 0;

  const refreshTarget = (): boolean => {
    if (!opts?.liveTarget) return true;
    const t = opts.liveTarget();
    if (!t) return false;
    gx = t.x;
    gy = t.y;
    gz = t.z;
    return true;
  };

  while (!token.cancelled && attempts < maxAttempts) {
    attempts++;
    if (!refreshTarget()) {
      report({ done: 1, total: 1, label: "parkur target kayboldu" });
      return;
    }

    const dist = bot.entity.position.distanceTo(v3(gx, gy, gz) as never);
    if (dist <= range + 0.8) {
      report({ done: 1, total: 1, label: "parkour reached target" });
      return;
    }

    const yNow = bot.entity.position.y;
    // merdiven sadece target hâlâ anlamlı şekilde yukarıdaysa
    const needClimb = cfg.ladderParkour && gy > yNow + 2.2 && Date.now() >= ladderCooldownUntil;
    if (needClimb) {
      const fy = Math.floor(yNow);
      const fx = Math.floor(bot.entity.position.x);
      const fz = Math.floor(bot.entity.position.z);
      let hasLadder = false;
      for (let dy = 0; dy < 6; dy++) {
        if (isLadder(bot, fx, fy + dy, fz)) {
          hasLadder = true;
          break;
        }
      }
      if (hasLadder) {
        const beforeY = yNow;
        const climbTo = Math.min(gy, beforeY + 6);
        const climbed = await climbLadderParkour(instance, climbTo, token, report, {
          shouldAbort: () => {
            if (token.cancelled) return true;
            if (!refreshTarget()) return true;
            // oyuncu indiyse / merdiven artık gereksiz
            if (gy <= (bot.entity?.position.y ?? 0) + 1.5) return true;
            // target yatayda uzaklaştı ve yükseklik farkı azaldı
            const horiz = Math.hypot(
              gx - (bot.entity?.position.x ?? 0),
              gz - (bot.entity?.position.z ?? 0)
            );
            if (horiz > 14 && gy < (bot.entity?.position.y ?? 0) + 3) return true;
            return false;
          },
          pathMs: 6_000,
          manualMs: 8_000
        });
        if (!climbed) {
          ladderCooldownUntil = Date.now() + 4000;
          instance.getLogger().info("Parkur", "merdiven abandoned — pathfinder / yeni target");
          clearControls(bot);
          await sleep(150);
        } else if ((bot.entity?.position.y ?? 0) > beforeY + 0.8) {
          continue;
        }
      }
    }

    if (!refreshTarget()) {
      report({ done: 1, total: 1, label: "parkur target kayboldu" });
      return;
    }

    const goal = new goals.GoalNear(gx, gy, gz, Math.max(1, range));
    try {
      await runPathOnce(instance, goal, token, 20_000);
      if (!refreshTarget()) return;
      if (bot.entity.position.distanceTo(v3(gx, gy, gz) as never) <= range + 1) {
        report({ done: 1, total: 1, label: "parkour reached target" });
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!cfg.enabled || (!msg.includes("noPath") && !msg.includes("yol"))) {
        if (attempts >= maxAttempts) throw e;
      }

      if (!refreshTarget()) return;
      if (cfg.enabled) {
        if (opts?.liveTarget) {
          const live = {
            get position() {
              const t = opts.liveTarget?.();
              return t ?? { x: gx, y: gy, z: gz };
            }
          };
          const ok = await tryCommittedGapJumpToward(instance, live, token, report);
          if (ok) continue;
        } else {
          const land = findGapLanding(bot, { x: gx, y: gy, z: gz }, cfg.maxGap);
          if (land && land.gap <= cfg.maxGap) {
            instance.getLogger().info("Parkur gap jump", `${land.gap} blok → ${land.x},${land.y},${land.z}`);
            const ok = await executeGapJump(instance, land, land.gap, token, report);
            if (ok) continue;
          }
        }
      }

      await sleep(250);
      if (attempts >= maxAttempts) throw e instanceof Error ? e : new Error(msg);
    }
  }

  if (token.cancelled) throw new Error(token.reason ?? "cancelled");
  refreshTarget();
  if (bot.entity.position.distanceTo(v3(gx, gy, gz) as never) > range + 1.5) {
    throw new Error("Could not reach target via parkour");
  }
  report({ done: 1, total: 1, label: "parkour reached target" });
}

async function runPathOnce(
  instance: BotInstance,
  goal: goals.Goal,
  token: TaskToken,
  timeoutMs: number
): Promise<void> {
  const bot = ensureParkourBot(instance);
  return new Promise((resolve, reject) => {
    const stop = () => {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
    };
    const cleanup = () => {
      clearInterval(watch);
      clearTimeout(deadline);
      bot.removeListener("goal_reached", onReached);
      bot.removeListener("path_update", onPath);
    };
    const onReached = () => {
      cleanup();
      resolve();
    };
    const onPath = (r: { status: string }) => {
      if (r.status === "noPath") {
        cleanup();
        stop();
        reject(new Error("noPath"));
      } else if (r.status === "timeout") {
        cleanup();
        stop();
        reject(new Error("path timeout"));
      }
    };
    const watch = setInterval(() => {
      if (token.cancelled) {
        cleanup();
        stop();
        reject(new Error(token.reason ?? "cancelled"));
      }
    }, 200);
    const deadline = setTimeout(() => {
      cleanup();
      stop();
      reject(new Error("parkour path timeout"));
    }, timeoutMs);
    bot.on("goal_reached", onReached);
    bot.on("path_update", onPath);
    try {
      bot.pathfinder.setGoal(goal);
    } catch (e) {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

const parkourKicked = new WeakSet<Bot>();

/**
 * Pathfinder plans 2–3 block parkour moves but cannot back up for a run-up. When the
 * bot already stands on the lip (follow brought it there), its own physics check says
 * the jump fails from a standstill and it waits until a watchdog fires (~10 s). When
 * the next node is a parkour move and the bot has not moved for 0.6 s, take that
 * jump with the run-up and tick-planned takeoff, then hand the goal back.
 */
export function installParkourKick(instance: BotInstance): void {
  const bot = instance.bot;
  if (!bot || parkourKicked.has(bot)) return;
  parkourKicked.add(bot);
  let path: Array<{ x: number; y: number; z: number; parkour?: boolean }> | null = null;
  let still = 0;
  let busy = false;
  // a jump the rehearsal turned down: leave it to pathfinder for a while (no retry loop)
  let declined: { key: string; until: number } | null = null;
  bot.on("path_update", (r: { path?: Array<{ x: number; y: number; z: number; parkour?: boolean }> }) => {
    path = r.path ?? null;
    still = 0;
  });
  bot.on("goal_reached", () => {
    path = null;
  });
  // a path planned before a stop, a new goal or a teleport is not this bot's path any more
  for (const ev of ["path_reset", "goal_updated", "path_stop", "caya_teleported"]) {
    bot.on(ev as never, (() => {
      path = null;
      still = 0;
    }) as never);
  }
  bot.on("physicsTick", () => {
    try {
      if (busy || !path || path.length === 0 || !bot.entity || parkourLocks.has(bot)) {
        still = 0;
        return;
      }
      const n = path[0]!;
      const v = bot.entity.velocity;
      // never cut into a jump pathfinder has already started (it fell short into lava)
      if (!n.parkour || !bot.entity.onGround || bot.getControlState("jump")) {
        still = 0;
        return;
      }
      // Onto a 1x1 pillar or a beam end pathfinder sprint-jumps straight past it:
      // take those at once with the braking jump. Others only when stalled.
      const sx = Math.sign(Math.floor(n.x) - Math.floor(bot.entity.position.x));
      const sz = Math.sign(Math.floor(n.z) - Math.floor(bot.entity.position.z));
      const narrowLanding = !isPlatformStand(bot, Math.floor(n.x) + sx, Math.floor(n.y), Math.floor(n.z) + sz);
      if (!narrowLanding && Math.hypot(v.x, v.z) > 0.03) {
        still = 0;
        return;
      }
      const nodeKey = `${Math.floor(n.x)},${Math.floor(n.y)},${Math.floor(n.z)}`;
      if (declined && declined.key === nodeKey && Date.now() < declined.until) return;
      if (++still < (narrowLanding ? 1 : 12)) return;
      still = 0;
      const goal = bot.pathfinder.goal as (goals.Goal & { entity?: unknown }) | null;
      if (!goal) return;
      const dynamic = goal.entity !== undefined;
      const p = bot.entity.position;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < 1.8) return;
      const moving = (bot.pathfinder as unknown as { isMoving?: () => boolean }).isMoving?.();
      if (!moving) return;
      const landing = { x: Math.floor(n.x), y: Math.floor(n.y), z: Math.floor(n.z) };
      const gap = Math.max(1, Math.round(d) - 1);
      // only a jump pathfinder could have planned from here: never a stale or far node
      const maxGap = parkourFromMovement(instance.config.movement).maxGap;
      if (gap > maxGap || Math.abs(n.y - p.y) > 1.6) return;
      busy = true;
      instance.getLogger().info("Parkour assist", `pathfinder stopped at a ${gap}-gap lip — taking the jump with a run-up`);
      void executeGapJump(instance, landing, gap, { cancelled: false })
        .catch(() => false)
        .then((ok) => {
          if (!ok) declined = { key: nodeKey, until: Date.now() + 5000 };
        })
        .finally(() => {
          busy = false;
          path = null;
          try {
            if (!bot.pathfinder.goal) bot.pathfinder.setGoal(goal, dynamic);
          } catch {
            /* */
          }
        });
    } catch {
      /* never break the physics loop */
    }
  });
}

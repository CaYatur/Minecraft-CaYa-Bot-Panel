import type { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
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
  /** özel gap jump üst sınırı: 2 | 3 | 4 */
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
  movements.canDig = Boolean(cfg.canDig);
  movements.allowSprinting = cfg.parkourSprint !== false && cfg.allowSprint !== false;
  movements.allowParkour = cfg.allowParkour !== false;
  movements.allow1by1towers = Boolean(cfg.allowTower);
  try {
    (movements as { maxDropDown?: number }).maxDropDown = Math.max(cfg.maxDrop ?? 3, Math.min(8, (cfg.parkourMaxGap ?? 3) + 2));
  } catch {
    /* */
  }
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

/** Y the player would stand at in this cell, or null if nothing to land on. */
function standYAt(bot: Bot, x: number, yHint: number, z: number): number | null {
  for (const dy of [0, 1, -1, 2, -2]) {
    const y = yHint + dy;
    if (!isSolid(bot, x, y - 1, z)) continue;
    if (!isAirish(bot, x, y, z) || !isAirish(bot, x, y + 1, z)) continue;
    return y;
  }
  return null;
}

/** Horizontal distance to the first non-standable cell in direction (ux, uz). */
function distToFrontEdge(bot: Bot, ux: number, uz: number): number {
  const pos = bot.entity?.position;
  if (!pos) return 0;
  const py = Math.floor(pos.y);
  for (let t = 0.05; t <= 4.05; t += 0.1) {
    const x = Math.floor(pos.x + ux * t);
    const z = Math.floor(pos.z + uz * t);
    if (standYAt(bot, x, py, z) === null) return t;
  }
  return 4;
}

function isLadder(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(v3(x, y, z));
  if (!b) return false;
  const n = b.name.replace(/^minecraft:/, "");
  return n === "ladder" || n === "vine" || n.includes("vine") || n === "scaffolding" || n === "twisting_vines" || n === "weeping_vines";
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

  for (let d = 1; d <= maxGap + 3; d++) {
    const cx = px + step.dx * d;
    const cz = pz + step.dz * d;
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
    if (airBlocks < 2 || airBlocks > maxGap) break;

    const flyY = Math.max(py, sy);
    let blocked = false;
    for (let t = gapStart; t < d; t++) {
      const mx = px + step.dx * t;
      const mz = pz + step.dz * t;
      if (isSolid(bot, mx, flyY, mz) || isSolid(bot, mx, flyY + 1, mz)) {
        blocked = true;
        break;
      }
    }
    if (blocked) break;

    const toGoal = Math.hypot(goal.x - (cx + 0.5), goal.y - sy, goal.z - (cz + 0.5));
    const fromHere = Math.hypot(goal.x - origin.x, goal.z - origin.z);
    if (fromHere - toGoal < 1.2) break;
    return { x: cx, y: sy, z: cz, gap: airBlocks, score: toGoal + airBlocks * 0.12 };
  }
  return null;
}

/**
 * Nearby parkour landing toward the goal: 2–4 air cells, same / ±2 Y.
 * Only looks a few blocks ahead so we jump the gap in front, not a distant hole.
 */
export function findGapLanding(
  bot: Bot,
  goal: { x: number; y: number; z: number },
  maxGap: ParkourGap
): { x: number; y: number; z: number; gap: number } | null {
  if (!bot.entity) return null;
  const pos = bot.entity.position;
  const gdx = goal.x - pos.x;
  const gdz = goal.z - pos.z;
  if (Math.hypot(gdx, gdz) < 1.6) return null;

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

  return best ? { x: best.x, y: best.y, z: best.z, gap: best.gap } : null;
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
  const need = gap >= 4 ? 2.5 : 1.7;
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
 * Sprint toward the committed landing and jump on the last pixels of the takeoff block.
 * Does not retarget — yaw was already locked onto the landing.
 */
async function sprintJumpAtEdge(
  bot: Bot,
  dir: { ux: number; uz: number },
  gap: number,
  token: TaskToken
): Promise<void> {
  const maxMs = gap >= 4 ? 950 : gap === 3 ? 720 : 280;
  const jumpAt = gap >= 4 ? 0.34 : gap === 3 ? 0.22 : 0.16;
  const minSpeed = gap >= 4 ? 0.22 : gap === 3 ? 0.15 : 0;
  bot.setControlState("sneak", false);
  bot.setControlState("forward", true);
  if (gap >= 2) bot.setControlState("sprint", true);

  const t0 = Date.now();
  let jumped = false;
  while (Date.now() - t0 < maxMs && !token.cancelled && bot.entity) {
    const edge = distToFrontEdge(bot, dir.ux, dir.uz);
    const speed = Math.hypot(bot.entity.velocity?.x ?? 0, bot.entity.velocity?.z ?? 0);
    const inAir = bot.entity.onGround === false;
    if (!jumped && (inAir || edge <= jumpAt)) {
      if (inAir || speed >= minSpeed || edge <= 0.08 || Date.now() - t0 > maxMs - 90) {
        bot.setControlState("jump", true);
        jumped = true;
        await sleep(gap >= 4 ? 80 : gap === 3 ? 65 : 50);
        bot.setControlState("jump", false);
        break;
      }
    }
    await sleep(20);
  }
  if (!jumped && bot.entity) {
    bot.setControlState("jump", true);
    await sleep(55);
    bot.setControlState("jump", false);
  }
}

/**
 * Kontrollü sprint jump: 2 / 3 / 4 blok boşluk.
 * gap=2: kısa sprint+zıpla · gap=3: edge timing · gap=4: run-up + sprint jump
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

  const g = Math.min(4, Math.max(2, Math.round(gap)));
  report?.({ done: 0, total: 1, label: `parkur ${g} blok atlama → ${landing.x},${landing.y},${landing.z}` });
  try {
    await handoffToManualControl(bot);

    const lx = landing.x + 0.5;
    const ly = landing.y;
    const lz = landing.z + 0.5;
    const pos0 = bot.entity.position;
    const dx = lx - pos0.x;
    const dz = lz - pos0.z;
    const len = Math.hypot(dx, dz) || 1;
    const dir = { ux: dx / len, uz: dz / len };

    await prepareRunUp(bot, dir, g, token);
    if (token.cancelled) {
      clearControls(bot);
      throw new Error(token.reason ?? "cancelled");
    }

    // Commit: look once at the landing, then never chase the moving target.
    await alignManualLookAt(bot, v3(lx, ly + 0.5, lz));
    await sprintJumpAtEdge(bot, dir, g, token);
    if (token.cancelled) {
      clearControls(bot);
      throw new Error(token.reason ?? "cancelled");
    }

    bot.setControlState("forward", true);
    if (g >= 2) bot.setControlState("sprint", true);
    const airDeadline = Date.now() + (g === 2 ? 750 : g === 3 ? 950 : 1200);
    let fellPast = false;
    while (Date.now() < airDeadline && !token.cancelled) {
      const ent = bot.entity;
      if (!ent) break;
      const pos = ent.position;
      const vy = ent.velocity?.y ?? 0;
      if (pos.y < ly - 1.4 && vy < -0.35) {
        fellPast = true;
        clearControls(bot);
        break;
      }
      const fg = instance.survival?.getFallGuardState?.();
      if (fg?.active || (fg?.falling && (fg.predictedDamage ?? 0) >= 2)) {
        fellPast = true;
        clearControls(bot);
        break;
      }
      const d = Math.hypot(pos.x - lx, pos.z - lz);
      if (ent.onGround && d < 1.45 && Math.abs(pos.y - ly) < 1.6) break;
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
      Math.hypot(pos.x - lx, pos.z - lz) < 1.7 &&
      Math.abs(pos.y - ly) < 1.8;

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

    const maxGap = (cfg.sprintJumps ? 4 : cfg.maxGap) as ParkourGap;
    const land = findGapLanding(bot, aim, maxGap);
    if (!land || land.gap < 2) return false;
    instance.getLogger().info("Committed gap jump", `gap=${land.gap} → ${land.x},${land.y},${land.z}`);
    return await executeGapJump(instance, land, land.gap, token, report);
  } finally {
    parkourLocks.delete(bot);
  }
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

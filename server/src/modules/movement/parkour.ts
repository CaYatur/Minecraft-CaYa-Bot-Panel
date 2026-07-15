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

/**
 * Botun baktığı yönde / targete doğru 2–4 blok parkour inişi ara.
 */
export function findGapLanding(
  bot: Bot,
  goal: { x: number; y: number; z: number },
  maxGap: ParkourGap
): { x: number; y: number; z: number; gap: number } | null {
  if (!bot.entity) return null;
  const px = Math.floor(bot.entity.position.x);
  const py = Math.floor(bot.entity.position.y);
  const pz = Math.floor(bot.entity.position.z);

  const gdx = goal.x - bot.entity.position.x;
  const gdz = goal.z - bot.entity.position.z;
  const glen = Math.hypot(gdx, gdz) || 1;
  const ux = gdx / glen;
  const uz = gdz / glen;

  let best: { x: number; y: number; z: number; gap: number; score: number } | null = null;

  // 2..maxGap blok önde iniş platformu ara (aynı / ±1 y)
  for (let gap = 2; gap <= maxGap; gap++) {
    for (const dy of [0, 1, -1, 2, -2]) {
      // gap = boşluk; iniş ≈ gap+1 blok merkez distancesi
      const dist = gap + 0.2;
      for (const side of [0, 0.35, -0.35]) {
        // yan ofset (diagonal parkour)
        const pxo = -uz * side;
        const pzo = ux * side;
        const lx = Math.floor(px + ux * dist + pxo);
        const ly = py + dy;
        const lz = Math.floor(pz + uz * dist + pzo);

        // iniş: solid top, üstü hava
        if (!isSolid(bot, lx, ly - 1, lz) && !isSolid(bot, lx, ly, lz)) continue;
        const standY = isSolid(bot, lx, ly, lz) ? ly + 1 : ly;
        if (!isAirish(bot, lx, standY, lz) || !isAirish(bot, lx, standY + 1, lz)) continue;

        // arada büyük engel var mı (basit)
        let blocked = false;
        for (let t = 1; t < gap; t++) {
          const mx = Math.floor(px + ux * t);
          const mz = Math.floor(pz + uz * t);
          if (isSolid(bot, mx, standY, mz) || isSolid(bot, mx, standY + 1, mz)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        const toGoal = Math.hypot(goal.x - lx, goal.y - standY, goal.z - lz);
        const score = toGoal + gap * 0.3;
        if (!best || score < best.score) {
          best = { x: lx, y: standY, z: lz, gap, score };
        }
      }
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z, gap: best.gap } : null;
}

/**
 * Kontrollü sprint jump: 2 / 3 / 4 blok boşluk.
 * gap=2: kısa sprint+zıpla · gap=3: edge timing · gap=4: run-up + sprint jump
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
  ensureParkourBot(instance);

  const g = Math.min(4, Math.max(2, Math.round(gap)));
  report?.({ done: 0, total: 1, label: `parkur ${g} blok atlama → ${landing.x},${landing.y},${landing.z}` });
  await handoffToManualControl(bot);

  const lx = landing.x + 0.5;
  const ly = landing.y;
  const lz = landing.z + 0.5;

  // Hedefe yalnızca hareket başlamadan önce, yumuşak biçimde hizalan.
  await alignManualLookAt(bot, v3(lx, ly + 0.5, lz));

  // kenara hizalan — acele etme (daha emin iniş)
  const edgeMs = g >= 4 ? 320 : g === 3 ? 220 : 150;
  bot.setControlState("forward", true);
  if (g >= 3) bot.setControlState("sprint", true);
  await sleep(edgeMs);
  if (token.cancelled) {
    clearControls(bot);
    throw new Error(token.reason ?? "cancelled");
  }

  // zıpla — kısa basış, sonra drop
  if (g >= 4) await sleep(60);
  bot.setControlState("jump", true);
  await sleep(g >= 4 ? 80 : g === 3 ? 70 : 60);
  bot.setControlState("jump", false);
  if (token.cancelled) {
    clearControls(bot);
    throw new Error(token.reason ?? "cancelled");
  }

  // havada yön tut (daha kontrollü süre)
  bot.setControlState("forward", true);
  if (g >= 3) bot.setControlState("sprint", true);
  const airMs = g === 2 ? 360 : g === 3 ? 460 : 560;
  const t0 = Date.now();
  let fellPast = false;
  while (Date.now() - t0 < airMs && !token.cancelled) {
    const pos = bot.entity.position;
    const vy = bot.entity.velocity?.y ?? 0;
    // inişi kaçırdı / tehlikeli düşüş — lookAt durdur, MLG'ye drop
    if (pos.y < ly - 1.4 && vy < -0.35) {
      fellPast = true;
      clearControls(bot);
      break;
    }
    // FallGuard MLG başladıysa parkur bakışını drop
    const fg = instance.survival?.getFallGuardState?.();
    if (fg?.active || (fg?.falling && (fg.predictedDamage ?? 0) >= 2)) {
      fellPast = true;
      clearControls(bot);
      break;
    }
    // Havada yaw değiştirme: yön, başlangıç hizası ve hareket momentumu ile korunur.
    // inişe yaklaştıysa drop
    const d = pos.distanceTo(v3(lx, ly, lz) as never);
    if (d < 1.2 && bot.entity.onGround) break;
    await sleep(40);
  }

  clearControls(bot);
  if (fellPast) {
    instance.getLogger().info("Parkour jump", "landing missed — abandoned to MLG");
    await yieldFallToMlg(instance, bot, token);
    return false;
  }
  await sleep(80);

  if (token.cancelled) throw new Error(token.reason ?? "cancelled");

  // başarı: iniş bloğuna yakın ve yerde
  const pos = bot.entity.position;
  const landed =
    bot.entity.onGround &&
    Math.hypot(pos.x - lx, pos.z - lz) < 1.6 &&
    Math.abs(pos.y - ly) < 1.8;

  if (landed) {
    report?.({ done: 1, total: 1, label: `parkur ${g} OK` });
    instance.getLogger().info(`Parkour jump succeeded`, `${g} blok → ${landing.x},${landing.y},${landing.z}`);
  } else {
    instance.getLogger().debug("Parkour jump weak landing", `gap=${g} d=${Math.hypot(pos.x - lx, pos.z - lz).toFixed(1)}`);
  }
  return landed;
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
        const land = findGapLanding(bot, { x: gx, y: gy, z: gz }, cfg.maxGap);
        if (land && land.gap <= cfg.maxGap) {
          instance.getLogger().info("Parkur gap jump", `${land.gap} blok → ${land.x},${land.y},${land.z}`);
          const ok = await executeGapJump(instance, land, land.gap, token, report);
          if (ok) continue;
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

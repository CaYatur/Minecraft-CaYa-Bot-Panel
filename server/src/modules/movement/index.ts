import type { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";
import { isTokenAborted, type TaskToken, type ProgressFn } from "../../core/TaskQueue";
import type { MovementConfig } from "../../types";
import {
  installDoorMovementAssist,
  isWoodenOpenableBlock,
  patchMovementsForDoors,
  tryPassNearbyDoor
} from "./doors";
import { easeLookAt, entityLookPoint, stepLookAtEntity } from "./look";
import {
  findElevatedApproach,
  findReplayJump,
  GoalFollowAtHeight,
  isParkourLocked,
  installParkourKick,
  installSpiralLadderAssist,
  isTurningLadder,
  patchMovementsForTurningLadders,
  pruneObservedJumps,
  pushObservedJump,
  tryGapJumpTowardPoint,
  tryJumpAcrossToPlayer,
  tryReplayObservedJump,
  type ObservedJump
} from "./parkour";
import { installWaterMovementAssist } from "./water";
import { cutPathAtDrop, PlayerTrail, type Vec as TrailVec } from "./trail";

export { tryOpenNearbyDoor, tryPassNearbyDoor } from "./doors";

/**
 * HAREKET ÇEKİRDEĞİ — tek altın kural (TODO §12'ye de yazıldı):
 * mineflayer-pathfinder, aktif bir goal varken DÜMENİN SAHİBİDİR — yürüyüş yönünü
 * kendi verdiği bakış (yaw) ile çizer. Rota aktifken bot.look'a dokunmak botu yanlış
 * yöne yürütür, zıplamaları ıskalatır, merdivenden düşürür ("geri atılma" hatası).
 * İnsanî bakış SADECE bot dururken (pathfinder.isMoving() === false) uygulanır.
 * Aynı sebeple takipte goal sürekli yenilenmez: GoalFollow(dynamic=true) targeti
 * kendisi izler; yenileme yalnızca entity REFERANSI değişince yapılır.
 */

const GOTO_TIMEOUT_MS = 180_000;
const STUCK_WINDOW_MS = 10_000; // if no position change: repath once then give up
const FOLLOW_TICK_MS = 150;
const FOLLOW_REPORT_MS = 1500; // panel report at most this often (no 10Hz spam)
const FOLLOW_STUCK_MS = 5_000; // follow stuck watchdog: repath to current player pos

/**
 * A* detour budgets (pathfinder `searchRadius` is maxCost = h(start) + budget).
 * Inside a build the unbounded search dropped off the edge and flooded the
 * terrain below: 25k+ nodes, 4 s timeout, bot parked under the player. A small
 * budget prunes those branches; if no path fits we widen and search again, so a
 * route that exists is still found (and the shortest one within the budget).
 */
export const SEARCH_BUDGETS = [40, 120, -1] as const;

/** Back to pathfinder's default (unbounded) for code that sets goals directly. */
export function resetSearchBudget(bot: Bot): void {
  try {
    (bot.pathfinder as unknown as { searchRadius: number }).searchRadius = -1;
  } catch {
    /* */
  }
}

export function setSearchBudget(bot: Bot, level: number): void {
  try {
    (bot.pathfinder as unknown as { searchRadius: number }).searchRadius =
      SEARCH_BUDGETS[Math.max(0, Math.min(SEARCH_BUDGETS.length - 1, level))];
  } catch {
    /* */
  }
}
const LADDER_HOP_COOLDOWN_MS = 5_000;

/**
 * Run `fn` once the bot stands on something. pathfinder.setGoal releases every key at
 * once; done in mid-air it cut a jump short and the bot fell into the gap (a follow
 * re-plan while the followed player moved on).
 */
function whenGrounded(bot: Bot, fn: () => void, maxTicks = 40): void {
  if (!bot.entity || bot.entity.onGround) {
    fn();
    return;
  }
  let n = 0;
  const onTick = () => {
    n++;
    if (!bot.entity || bot.entity.onGround || n >= maxTicks) {
      bot.removeListener("physicsTick", onTick);
      fn();
    }
  };
  bot.on("physicsTick", onTick);
}

/** Emitted on the bot after a server teleport moved it this far (blocks). */
export const TELEPORT_EVENT = "caya_teleported";
const TELEPORT_MIN_JUMP = 4;
const teleportWatched = new WeakSet<Bot>();

/**
 * A teleport (/tp, a plugin, a setback across a gap) left pathfinder walking the
 * path planned from the old spot: the bot kept heading back toward it for a while.
 * Re-plan the same goal from where the bot is now.
 */
/**
 * Several server setbacks in a row (an anti-cheat that rejected a step) kept coming
 * for as long as the bot kept pushing: it stood in place sprinting into each one
 * (GrimAC, issue #34). Let go of every key for a few ticks so the server's idea of
 * the player settles, as a player who rubber-bands does.
 */
const setbackCalmed = new WeakSet<Bot>();
function installSetbackCalm(bot: Bot): void {
  if (setbackCalmed.has(bot)) return;
  setbackCalmed.add(bot);
  const recent: number[] = [];
  let calmTicks = 0;
  let lastPos: Vec3 | null = null;
  bot.on("physicsTick", () => {
    if (bot.entity) lastPos = bot.entity.position.clone();
    if (calmTicks <= 0) return;
    calmTicks--;
    for (const c of ["forward", "back", "left", "right", "jump", "sprint"] as const) bot.setControlState(c, false);
  });
  bot.on("forcedMove", () => {
    const p = bot.entity?.position;
    if (!p) return;
    const jump = lastPos ? p.distanceTo(lastPos) : 99;
    if (jump >= TELEPORT_MIN_JUMP) return; // a real teleport, not a setback
    const now = Date.now();
    recent.push(now);
    while (recent.length && now - recent[0]! > 1000) recent.shift();
    if (recent.length >= 3 && calmTicks <= 0) {
      calmTicks = 8;
      recent.length = 0;
      (bot as unknown as { emit(e: string): void }).emit(SETBACK_STORM_EVENT);
    }
  });
}
export const SETBACK_STORM_EVENT = "caya_setback_storm";

function installTeleportReset(bot: Bot): void {
  if (teleportWatched.has(bot)) return;
  teleportWatched.add(bot);
  let last: Vec3 | null = null;
  bot.on("physicsTick", () => {
    if (bot.entity) last = bot.entity.position.clone();
  });
  bot.on("forcedMove", () => {
    const p = bot.entity?.position;
    if (!p) return;
    const jump = last ? p.distanceTo(last) : 0;
    last = p.clone();
    if (jump < TELEPORT_MIN_JUMP) return;
    try {
      (bot as unknown as { emit(e: string, d: number): void }).emit(TELEPORT_EVENT, jump);
    } catch {
      /* */
    }
    try {
      const pf = bot.pathfinder as unknown as { goal?: unknown; movements?: unknown; setMovements?(m: unknown): void };
      if (pf.goal && pf.movements && !isParkourLocked(bot)) pf.setMovements?.(pf.movements); // resets the path, keeps the goal
    } catch {
      /* */
    }
  });
}

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline — cannot run movement task.");
  return bot;
}

function moveCfg(instance: BotInstance): MovementConfig {
  return instance.config.movement;
}

/** How far we may drop without dying. Config is a floor; health raises it. */
function smartMaxDropDown(bot: Bot, cfg: MovementConfig): number {
  const hp = Math.max(0, bot.health ?? 20);
  const keepHp = 4; // never plan a fall that leaves us under 2 hearts
  const affordableDmg = Math.max(0, Math.floor(hp - keepHp));
  const byHealth = 3 + affordableDmg;
  const configured = Math.max(2, cfg.maxDrop ?? 3);
  return Math.max(configured, Math.min(10, byHealth));
}

/** İnsanî dönüş hızı (°/tick) — sadece DURURKEN yapılan bakışlarda kullanılır */
function turnSpeed(instance: BotInstance): number {
  const c = moveCfg(instance);
  return Math.max(8, Math.min(28, c.lookTurnDegPerTick ?? 16));
}

function pfIsMoving(bot: Bot): boolean {
  try {
    const pf = bot.pathfinder as unknown as { isMoving?(): boolean };
    return pf.isMoving?.() ?? false;
  } catch {
    return false;
  }
}

export interface EnsureMovementOpts {
  allowSprintNow?: boolean;
  /** true/false overrides config; omit to use config.allowParkour */
  parkour?: boolean;
  /** takip for canDig kapatılır (başkasının parkurunu/haritasını kazmasın) */
  canDig?: boolean;
  /** kapı ve çit kapılarını kırmak yerine aç */
  canOpenDoors?: boolean;
  /** blok place (scaffold). Takipte varsayılan KAPALI — merdiven/parkurda
   *  konan blok botu sıkıştırıyor ve haritayı bozuyordu. */
  allowPlace?: boolean;
  /** "follow": canDig=false + allowPlace=false varsayılır */
  mode?: "follow" | "goto" | "parkour";
  /** If set, pathfinder may break only these blocks (leaves on a tree walk). Terrain stays intact. */
  breakOnly?: (name: string) => boolean;
}

/** pathfinder eklentisini yükle + Movements'ı config'ten kur */
export function ensureMovement(instance: BotInstance, opts?: EnsureMovementOpts): Bot {
  const bot = requireBot(instance);
  const anyBot = bot as unknown as { pathfinder?: unknown };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);
  installLadderEndGuard(bot);
  installTeleportReset(bot);
  installSetbackCalm(bot);
  installSpiralLadderAssist(bot);
  installParkourKick(instance);
  // caya-water-movement-stability-v1: akıntı, yüzey ve kıyıya çıkış stabilizasyonu.
  installWaterMovementAssist(bot);
  installDoorMovementAssist(bot);

  const cfg = moveCfg(instance);
  const movements = new Movements(bot);
  const registry = bot.registry;

  // Survival place/break toggles are a hard kill-switch (combat flags stay separate).
  const survivalDig = cfg.canDig !== false;
  const survivalPlace = cfg.allowPlace !== false;
  const digDefault = opts?.mode === "follow" ? false : Boolean(cfg.canDig);
  movements.canDig =
    !survivalDig && !opts?.breakOnly ? false : opts?.canDig !== undefined ? opts.canDig : digDefault;
  movements.allowSprinting = opts?.allowSprintNow !== undefined ? opts.allowSprintNow : cfg.allowSprint !== false;
  // Parkur: pathfinder'ın YERLEŞİK parkuru (1-4 blok boşluk + sprint jump) — merdiven
  // tırmanışı zaten doğal yetenek, ayrı bayrak gerekmez.
  // parkour: false must actually disable it (farm tilling tramples on sprint-jumps).
  movements.allowParkour = opts?.parkour !== undefined ? opts.parkour : cfg.allowParkour !== false;
  movements.allow1by1towers = survivalPlace && Boolean(cfg.allowTower);
  // Vanilla: first 3 blocks of fall are free, then 1 HP per extra block.
  // Take the short drop if it will not kill; walk around only when lethal.
  movements.maxDropDown = smartMaxDropDown(bot, cfg);
  // Pathfinder only climbs ladders; vines climb the same way in the game (and in the physics)
  const vine = registry.blocksByName.vine;
  if (vine) movements.climbables.add(vine.id);
  // Magma burns a walking player: go round it when a few blocks of detour do (the fire guard
  // otherwise pulled the bot off its route).
  const magma = registry.blocksByName.magma_block;
  if (magma) {
    movements.exclusionAreasStep.push((b: { position?: Vec3 }) => {
      if (!b.position) return 0;
      const below = bot.blockAt(b.position.offset(0, -1, 0), false);
      return below?.type === magma.id ? 6 : 0;
    });
  }
  // Pathfinder treats a cobweb as a wall; a player wades through it slowly. Allow it at a high
  // cost, so a web is only crossed when there is no other way (a webbed corridor or door).
  const web = registry.blocksByName.cobweb ?? registry.blocksByName.web;
  if (web && movements.blocksToAvoid.delete(web.id)) {
    movements.exclusionAreasStep.push((b: { type?: number }) => (b.type === web.id ? 20 : 0));
  }
  const canOpenDoors = opts?.canOpenDoors !== false;
  if ("canOpenDoors" in movements) {
    (movements as unknown as { canOpenDoors: boolean }).canOpenDoors = canOpenDoors;
  }
  if (canOpenDoors) {
    for (const block of registry.blocksArray) {
      const name = block.name.toLowerCase();
      const openable = (name.endsWith("_door") || name.endsWith("_fence_gate") || name.endsWith("_trapdoor")) && !name.includes("iron_");
      if (openable) movements.openable.add(block.id);
    }
    // Pathfinder always safeOrBreaks the HEAD cell (upper door half) before
    // useOne on the feet cell. Without this, canDig=false yields no path and
    // canDig=true queues the door to be broken (issue #11 / Mindcraft patch).
    const origSafe = (movements as unknown as { safeOrBreak: (block: { name?: string }, toBreak?: unknown[]) => number })
      .safeOrBreak.bind(movements);
    (movements as unknown as { safeOrBreak: (block: { name?: string }, toBreak?: unknown[]) => number }).safeOrBreak = (
      block,
      toBreak
    ) => {
      if (isWoodenOpenableBlock(block)) return 0;
      return origSafe(block, toBreak);
    };
    patchMovementsForDoors(bot, movements);
    const origForward = movements.getMoveForward.bind(movements);
    movements.getMoveForward = (node, dir, neighbors) => {
      const before = neighbors.length;
      origForward(node, dir, neighbors);
      for (let i = before; i < neighbors.length; i++) {
        const move = neighbors[i] as { toPlace?: Array<{ x: number; y: number; z: number; useOne?: boolean }> };
        if (!move.toPlace?.length) continue;
        // Pathfinder's useOne click can leave `placing=true` forever. We open
        // doors ourselves and walk the cell center (doors.ts).
        move.toPlace = move.toPlace.filter((p) => {
          if (!p.useOne) return true;
          const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
          return !isWoodenOpenableBlock(b);
        });
      }
    };
  }
  const breakOnly = opts?.breakOnly;
  if (breakOnly) {
    movements.canDig = true;
    for (const block of registry.blocksArray) {
      if (!breakOnly(block.name)) movements.blocksCantBreak.add(block.id);
    }
  } else if (movements.canDig === false) {
    for (const block of registry.blocksArray) movements.blocksCantBreak.add(block.id);
    movements.exclusionAreasBreak.push(() => 100);
  }

  // DİKKAT: Movements yapıcısı scafoldingBlocks'u KENDİLİĞİNDEN doldurur (dirt/cobble).
  // Placeme istenmiyorsa listeyi BOŞALTMAK şart — atlamak yetmez.
  const placeAllowed = !survivalPlace
    ? false
    : opts?.allowPlace !== undefined
      ? opts.allowPlace
      : opts?.mode !== "follow";
  if (!placeAllowed) {
    movements.scafoldingBlocks = [];
    movements.allow1by1towers = false;
  } else {
    const ids = (cfg.scaffoldBlocks ?? [])
      .map((name) => registry?.itemsByName?.[name]?.id)
      .filter((id): id is number => typeof id === "number");
    if (ids.length > 0) movements.scafoldingBlocks = ids;
  }

  patchMovementsForTurningLadders(movements);
  bot.pathfinder.setMovements(movements);
  try {
    const pf = bot.pathfinder as unknown as { thinkTimeout?: number };
    pf.thinkTimeout = opts?.mode === "follow" ? 4_000 : opts?.breakOnly ? 12_000 : movements.canDig ? 5_000 : 15_000;
  } catch {
    /* */
  }
  return bot;
}

// ---- ladder end guard (issue #34) ------------------------------------------------

const ladderGuarded = new WeakSet<Bot>();
const GUARDED = Symbol.for("caya.ladderEndGuard");

/** Ladder and vines: a cell you hang in, not one you stand in. Scaffolding is a floor. */
function isHangingCell(bot: Bot, x: number, y: number, z: number): boolean {
  const name = blockNameAt(bot, x, y, z);
  return name === "ladder" || name === "vine" || name.endsWith("_vines") || name === "weeping_vines_plant" || name === "twisting_vines_plant";
}

/**
 * A goal must not end with the bot hanging on a ladder. Follow (range 2) "arrived"
 * on the last rung while the player stood on the only exit block, pathfinder let
 * go, the bot slid down, follow restarted, and it bobbed on the ladder forever.
 * Unless the target itself is on a ladder, keep walking to a cell you can stand in.
 */
export function guardGoalAgainstLadderEnd(bot: Bot, goal: unknown): void {
  const g = goal as {
    isEnd?: (node: { x: number; y: number; z: number }) => boolean;
    entity?: Entity;
    x?: number;
    y?: number;
    z?: number;
    [GUARDED]?: boolean;
  } | null;
  if (!g || typeof g.isEnd !== "function" || g[GUARDED]) return;
  const orig = g.isEnd.bind(g);
  const targetHangs = () => {
    const tp = g.entity?.position;
    if (tp) return isHangingCell(bot, tp.x, tp.y, tp.z) || isHangingCell(bot, tp.x, tp.y - 1, tp.z);
    if (typeof g.x === "number" && typeof g.y === "number" && typeof g.z === "number") {
      return isHangingCell(bot, g.x, g.y, g.z);
    }
    return false;
  };
  g.isEnd = (node) => {
    if (!orig(node)) return false;
    // on a rung, or in the air just above the top rung (pathfinder's climb ends there)
    const hanging = isHangingCell(bot, node.x, node.y, node.z) || isHangingCell(bot, node.x, node.y - 1, node.z);
    if (!hanging) return true;
    return targetHangs();
  };
  g[GUARDED] = true;
}

function installLadderEndGuard(bot: Bot) {
  if (ladderGuarded.has(bot)) return;
  ladderGuarded.add(bot);
  const pf = bot.pathfinder as unknown as { setGoal(goal: unknown, dynamic?: boolean): void };
  const origSetGoal = pf.setGoal.bind(pf);
  pf.setGoal = (goal: unknown, dynamic?: boolean) => {
    guardGoalAgainstLadderEnd(bot, goal);
    return origSetGoal(goal, dynamic);
  };
}

// ---- merdiven atlayış asisti (takip) ----------------------------------------------

function blockNameAt(bot: Bot, x: number, y: number, z: number): string {
  try {
    const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
    return b?.name ?? "";
  } catch {
    return "";
  }
}

function isClimbable(name: string): boolean {
  return name === "ladder" || name === "vine";
}

/** bot şu an merdiven/sarmaşık hücresinde mi (ayak veya baş hizası) */
function onLadderNow(bot: Bot): boolean {
  const p = bot.entity?.position;
  if (!p) return false;
  return isClimbable(blockNameAt(bot, p.x, p.y, p.z)) || isClimbable(blockNameAt(bot, p.x, p.y + 1, p.z));
}

/**
 * Merdivenden başka yöndeki merdivene atlama (pathfinder'ın hamle setinde YOK).
 * Altın kurala uygun: goal önce DURDURULUR, manevra tek başına yapılır, kontrol
 * her durumda pathfinder'a geri verilir (çağıran goal'ü yeniden kurar).
 * Yalnızca takip takılınca ve bot merdiven üzerindeyken denenir; ~1.5 sn sınırlı.
 */
async function ladderHopAssist(bot: Bot, target: Entity): Promise<boolean> {
  const feet = bot.entity.position;
  const bx = Math.floor(feet.x);
  const by = Math.floor(feet.y);
  const bz = Math.floor(feet.z);

  // komşu merdiven adayları (kendi kolonu hariç), targete en yakın olanı seç
  let best: { x: number; y: number; z: number; dTarget: number } | null = null;
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue; // kendi kolonu
      const horiz = Math.hypot(dx, dz);
      if (horiz > 3.2) continue; // outside jump range
      for (let dy = -1; dy <= 3; dy++) {
        const x = bx + dx;
        const y = by + dy;
        const z = bz + dz;
        if (!isClimbable(blockNameAt(bot, x + 0.5, y + 0.5, z + 0.5))) continue;
        const dTarget = Math.hypot(x + 0.5 - target.position.x, y - target.position.y, z + 0.5 - target.position.z);
        if (!best || dTarget < best.dTarget) best = { x, y, z, dTarget };
      }
    }
  }
  if (!best) return false;

  // dümeni tamamen devral (pathfinder goal'ü çağıran durdurdu)
  try {
    bot.clearControlStates();
  } catch {
    /* */
  }
  try {
    // target merdivenin hücre merkezine dön (force=false — yumuşak dönüş)
    await bot.lookAt(new Vec3(best.x + 0.5, best.y + 0.5, best.z + 0.5), false);
  } catch {
    return false;
  }
  await sleep(150); // let aim settle

  bot.setControlState("forward", true);
  bot.setControlState("jump", true);
  let grabbed = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    await sleep(80);
    if (!bot.entity) break;
    if (onLadderNow(bot)) {
      const p = bot.entity.position;
      // gerçekten HEDEF kolona mı tutunduk (kalkış kolonuna geri değil)?
      if (Math.floor(p.x) === best.x && Math.floor(p.z) === best.z) {
        grabbed = true;
        break;
      }
    }
  }
  bot.setControlState("jump", false);
  bot.setControlState("forward", false);
  return grabbed;
}

/**
 * Statik targete git; söz verir. Bakış müdahalesi YOK — pathfinder sürer.
 * Takılma bekçisi: STUCK_WINDOW_MS boyunca yer değiştirme yoksa rota bir kez
 * tazelenir; ikinci pencerede de kıpırdamazsa anlaşılır hatayla düşer (Faz 4 [~] maddesi).
 */
function pathfinderGoal(
  instance: BotInstance,
  goal: goals.Goal,
  token: TaskToken,
  opts?: { timeoutMs?: number; onStuckRetry?: () => void; maxBudget?: number }
): Promise<void> {
  const bot = requireBot(instance);
  const timeoutMs = opts?.timeoutMs ?? GOTO_TIMEOUT_MS;
  const lastBudget = Math.min(SEARCH_BUDGETS.length - 1, opts?.maxBudget ?? SEARCH_BUDGETS.length - 1);
  const epoch = instance.controlEpoch;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let lastPos = bot.entity?.position?.clone?.() ?? null;
    let lastMoveAt = Date.now();
    let stuckRetried = false;

    const stopGoal = () => {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* bot düşmüş olabilir */
      }
    };
    const cleanup = () => {
      resetSearchBudget(bot);
      clearInterval(watch);
      clearTimeout(deadline);
      bot.removeListener("goal_reached", onReached);
      bot.removeListener("path_update", onPath);
      bot.removeListener(TELEPORT_EVENT as never, onTeleport as never);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onReached = (reached?: unknown) => {
      // Another module (the fire/lava/magma guard fleeing) can set its own goal for a moment;
      // reaching that one is not arriving here: aim at ours again.
      if (reached && reached !== goal) {
        setTimeout(() => {
          if (settled || bot.pathfinder.goal) return;
          try {
            bot.pathfinder.setGoal(goal);
          } catch {
            /* */
          }
        }, 300);
        return;
      }
      finish(resolve);
    };
    let budget = 0;
    setSearchBudget(bot, budget);
    const onTeleport = () => {
      budget = 0;
      setSearchBudget(bot, 0);
      lastPos = bot.entity?.position?.clone?.() ?? null;
      lastMoveAt = Date.now();
    };
    bot.on(TELEPORT_EVENT as never, onTeleport as never);
    let lastPathLogAt = 0;
    const onPath = (result: { status: string; path?: Array<{ y: number }>; time?: number; visitedNodes?: number }) => {
      if (result.status !== "partial" && Date.now() - lastPathLogAt > 1500) {
        lastPathLogAt = Date.now();
        instance.getLogger().debug("Path", `${result.status} budget=${SEARCH_BUDGETS[budget]} nodes=${result.visitedNodes ?? "?"} t=${Math.round(result.time ?? 0)}ms len=${result.path?.length ?? 0}`);
      }
      if (result.status !== "success" && result.path && bot.entity) {
        // best-effort path while no route is known: never step down into a pit
        const gy = (goal as unknown as { y?: number }).y;
        cutPathAtDrop(result.path, Math.min(bot.entity.position.y, typeof gy === "number" ? gy : bot.entity.position.y) - 1.5);
      }
      if ((result.status === "noPath" || result.status === "timeout") && budget < lastBudget) {
        // nothing fits this detour budget: widen and plan again (stand still meanwhile)
        if (result.path) result.path.length = 0;
        budget++;
        setSearchBudget(bot, budget);
        setImmediate(() =>
          whenGrounded(bot, () => {
            if (settled) return;
            try {
              bot.pathfinder.setGoal(goal);
            } catch {
              /* */
            }
          })
        );
        return;
      }
      if (result.status === "noPath") {
        finish(() => {
          stopGoal();
          reject(new Error("No safe path to target (noPath)."));
        });
      } else if (result.status === "timeout") {
        finish(() => {
          stopGoal();
          reject(new Error("Pathfinding timed out — target may be too far or blocked."));
        });
      }
    };

    const watch = setInterval(() => {
      if (settled) return;
      if (isTokenAborted(token) || instance.controlEpoch !== epoch) {
        finish(() => {
          stopGoal();
          reject(new Error(token.reason ?? "Task cancelled."));
        });
        return;
      }
      if (instance.status !== "online" || !bot.entity) {
        finish(() => reject(new Error("Connection lost — movement task ended.")));
        return;
      }

      // takılma bekçisi
      const pos = bot.entity.position;
      if (!lastPos || pos.distanceTo(lastPos) > 0.35) {
        lastPos = pos.clone();
        lastMoveAt = Date.now();
      } else if (Date.now() - lastMoveAt > STUCK_WINDOW_MS) {
        if (!stuckRetried) {
          stuckRetried = true;
          lastMoveAt = Date.now();
          opts?.onStuckRetry?.();
          void tryPassNearbyDoor(instance).then((passed) => {
            if (settled) return;
            try {
              bot.pathfinder.setGoal(goal);
            } catch {
              /* */
            }
            void passed;
          });
          try {
            bot.pathfinder.setGoal(goal); // recompute from scratch
          } catch {
            /* */
          }
        } else {
          finish(() => {
            stopGoal();
            reject(new Error("No progress — bot stuck (path recalculated twice, cannot reach)."));
          });
        }
      }
    }, 1000);

    const deadline = setTimeout(() => {
      finish(() => {
        stopGoal();
        reject(new Error("Could not reach target in time (task timeout)."));
      });
    }, timeoutMs);

    bot.on("goal_reached", onReached);
    bot.on("path_update", onPath);
    bot.pathfinder.setGoal(goal);
  });
}

export interface GotoOptions {
  /** Yol hesaplanırken arazi kazılabilsin mi? Kaynak/ağaç aramada false kullanılır. */
  canDig?: boolean;
  /** Pathfinder geçici blok/scaffold koyabilsin mi? */
  allowPlace?: boolean;
  /** Yerleşik parkur hareketleri açık mı? */
  parkour?: boolean;
  /** Bu hareket for özel zaman aşımı. */
  timeoutMs?: number;
  /** Pathfinder yalnızca bu blokları kırabilir (ağaç yürüyüşünde yaprak). */
  breakOnly?: (name: string) => boolean;
}

export async function runGoto(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  range: number,
  token: TaskToken,
  report: ProgressFn,
  options?: GotoOptions
): Promise<void> {
  const bot = requireBot(instance);
  const dist = Math.round(bot.entity.position.distanceTo({ x, y, z } as never));
  report({ done: 0, total: dist, label: `targete gidiliyor (${dist} blocks)` });

  ensureMovement(instance, {
    mode: "goto",
    canDig: options?.canDig,
    allowPlace: options?.allowPlace,
    parkour: options?.parkour,
    breakOnly: options?.breakOnly
  });
  if (moveCfg(instance).humanize !== false) await sleep(60 + Math.floor(Math.random() * 120)); // insanî tepki
  if (token.cancelled) throw new Error(token.reason ?? "Task cancelled.");

  // A* stops at 3-block gaps; on noPath try one configured sprint jump toward the
  // target and plan again (issue #34: 4-gap goto said "noPath" and never jumped).
  // Bounded searches first: when nothing walkable is near, a jump toward the target
  // comes before an unbounded search (that timed out in a big build and the jump
  // was never tried). Only then search everything.
  let bounded = true;
  for (let jumps = 0; ; jumps++) {
    try {
      await pathfinderGoal(instance, new goals.GoalNear(x, y, z, Math.max(1, range)), token, {
        timeoutMs: options?.timeoutMs,
        maxBudget: bounded ? SEARCH_BUDGETS.length - 2 : undefined,
        onStuckRetry: () => report({ done: 0, total: dist, label: "stuck — recalculating path" })
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const canJump = options?.parkour !== false && moveCfg(instance).allowParkour !== false;
      const searchFailed = /noPath|No progress|timed out/.test(msg);
      if (isTokenAborted(token) || !searchFailed) throw err;
      if (jumps >= 3 || !canJump) {
        if (!bounded) throw err;
        bounded = false;
        continue;
      }
      report({ done: 0, total: dist, label: "no walking path — trying a parkour jump" });
      const jumped = await tryGapJumpTowardPoint(
        instance,
        { x: x + 0.5, y, z: z + 0.5 },
        token,
        (lx, ly, lz) => pathfinderGoal(instance, new goals.GoalBlock(lx, ly, lz), token, { timeoutMs: 20_000 }),
        report
      );
      if (!jumped) {
        if (!bounded) throw err;
        bounded = false; // no jump to make: now search the whole area
        continue;
      }
      ensureMovement(instance, {
        mode: "goto",
        canDig: options?.canDig,
        allowPlace: options?.allowPlace,
        parkour: options?.parkour,
        breakOnly: options?.breakOnly
      });
    }
  }

  // varışta targete bak (bot artık DURUYOR — bakış serbest)
  try {
    await easeLookAt(bot, { x, y: y + 1.2, z }, turnSpeed(instance), 8);
  } catch {
    /* */
  }
  report({ done: dist, total: dist, label: "reached destination" });
}


/**
 * Yüzey keşfi for X/Z targetine gider; target Y seviyesini zorlamaz. Böylece ağaç
 * ararken tepeye ulaşmak for dağı delmek yerine doğal yüzey yolunu kullanır.
 */
export async function runGotoXZ(
  instance: BotInstance,
  x: number,
  z: number,
  range: number,
  token: TaskToken,
  report: ProgressFn,
  options?: GotoOptions
): Promise<void> {
  const bot = requireBot(instance);
  const dist = Math.round(Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z));
  report({ done: 0, total: dist, label: `searching on surface (${dist} blocks)` });

  ensureMovement(instance, {
    mode: "goto",
    canDig: options?.canDig,
    allowPlace: options?.allowPlace,
    parkour: options?.parkour,
    breakOnly: options?.breakOnly
  });
  if (moveCfg(instance).humanize !== false) await sleep(40 + Math.floor(Math.random() * 90));
  if (token.cancelled) throw new Error(token.reason ?? "Task cancelled.");

  await pathfinderGoal(instance, new goals.GoalXZ(x, z), token, {
    timeoutMs: options?.timeoutMs,
    onStuckRetry: () => report({ done: 0, total: dist, label: "recalculating surface path" })
  });
  report({ done: dist, total: dist, label: "reached search point" });
}

export async function runGotoPlayer(
  instance: BotInstance,
  playerName: string,
  range: number,
  token: TaskToken,
  report: ProgressFn,
  movementPolicy?: { canDig?: boolean; allowPlace?: boolean }
): Promise<void> {
  const bot = requireBot(instance);
  const entity = bot.players[playerName]?.entity;
  if (!entity) {
    const inTab = Boolean(bot.players[playerName]);
    throw new Error(
      inTab
        ? `${playerName} on server but out of sight range — position unknown. Place a nearby waypoint and retry.`
        : `${playerName} not visible on server.`
    );
  }
  report({ done: 0, total: 1, label: `${playerName} oyuncusuna gidiliyor` });

  ensureMovement(instance, { mode: "goto" });
  if (moveCfg(instance).humanize !== false) await sleep(60 + Math.floor(Math.random() * 120));
  if (token.cancelled) throw new Error(token.reason ?? "Task cancelled.");

  const p = entity.position;
  await pathfinderGoal(instance, new goals.GoalNear(p.x, p.y, p.z, Math.max(1, range)), token, {
    onStuckRetry: () => report({ done: 0, total: 1, label: "stuck — recalculating path" })
  });

  const e2 = bot.players[playerName]?.entity;
  if (e2) {
    try {
      await easeLookAt(bot, entityLookPoint(e2), turnSpeed(instance), 10);
    } catch {
      /* */
    }
  }
  report({ done: 1, total: 1, label: `${playerName} reached player` });
}

/**
 * Sürekli takip. Parkur yapan oyuncuyu da izler: GoalFollow(dynamic=true).
 * canDig takipte kapalı. Blok koyma varsayılan KAPALI; yalnızca yol yok /
 * uzun takılmada geçici scaffold (başka şeyi bozmaz).
 */
export async function runFollow(
  instance: BotInstance,
  playerName: string,
  distance: number,
  token: TaskToken,
  report: ProgressFn,
  movementPolicy?: { canDig?: boolean; allowPlace?: boolean }
): Promise<void> {
  const holdDist = Math.max(1, Math.min(16, distance));
  let lastReportAt = 0;
  let lastReportLabel = "";

  const throttledReport = (label: string) => {
    const now = Date.now();
    // mutlak alt sınır: etiket değişse bile 400ms'den sık YAYIN YOK (panel spam koruması)
    if (now - lastReportAt < 400) return;
    if (label === lastReportLabel && now - lastReportAt < FOLLOW_REPORT_MS) return;
    lastReportAt = now;
    lastReportLabel = label;
    report({ done: 0, total: 0, label });
  };

  const clearGoal = (bot: Bot) => {
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
  };

  let followMovesOn = false;
  let scaffoldOn = false;

  restoreDefaultMovement(instance);
  ensureMovement(instance, {
    mode: "follow",
    canDig: movementPolicy?.canDig ?? false,
    canOpenDoors: true,
    allowPlace: movementPolicy?.allowPlace ?? false
  });
  followMovesOn = true;
  if (instance.bot) setSearchBudget(instance.bot, 0);

  /** Takılınca / noPath: pathfinder'a geçici scaffold ver (config scaffoldBlocks) */
  const enableScaffoldForStuck = (bot: Bot) => {
    ensureMovement(instance, {
      mode: "follow",
      canDig: movementPolicy?.canDig ?? false,
      canOpenDoors: true,
      allowPlace: movementPolicy?.allowPlace === false ? false : true,
      parkour: moveCfg(instance).allowParkour !== false
    });
    followMovesOn = true;
    if (movementPolicy?.allowPlace === false) return false;
    scaffoldOn = true;
    // sadece sıkışınca: basamak/kule koyabilsin (sürekli açık değil)
    try {
      const mov = (bot.pathfinder as unknown as { movements?: Movements }).movements;
      if (mov) {
        mov.allow1by1towers = true;
      }
    } catch {
      /* */
    }
    return true;
  };

  const restoreFollowMovement = () => {
    // setMovements resets the path — skip unless we actually changed mode (scaffold).
    if (followMovesOn && !scaffoldOn) return;
    ensureMovement(instance, { mode: "follow", canDig: movementPolicy?.canDig ?? false, canOpenDoors: true, allowPlace: movementPolicy?.allowPlace ?? false });
    followMovesOn = true;
    scaffoldOn = false;
  };

  const observedJumps: ObservedJump[] = [];
  let budget = 0;
  // The player's own route: walked in short legs when no route to them is found.
  const trail = new PlayerTrail();
  let wantTrail = false;
  let trailActive = false;
  let lastTrailAt = 0;
  let lastCutLogAt = 0;
  let lastGoalRefreshAt = 0;
  let lastPathStatus = "";

  // Set when the bot is teleported: a trail walk planned from the old spot stops.
  let trailAbort = false;
  const trailToken = {
    get cancelled() {
      return token.cancelled || trailAbort;
    },
    get reason() {
      return trailAbort ? "teleported" : token.reason;
    },
    abort: token.abort
  } as TaskToken;
  const walkTrail = async (): Promise<boolean> => {
    const bot = requireBot(instance);
    if (!bot.entity || trail.size === 0) return false;
    trailActive = true;
    trailAbort = false;
    clearGoal(bot);
    throttledReport(`follow: ${playerName} · following your route`);
    instance.getLogger().info("Follow trail", `${trail.size} points`);
    const go = async (c: TrailVec, exact = false): Promise<boolean> => {
      const g = exact
        ? new goals.GoalBlock(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z))
        : new goals.GoalNear(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z), 1);
      try {
        await pathfinderGoal(instance, g, trailToken, { timeoutMs: 12_000 });
        return true;
      } catch {
        return false;
      }
    };
    const here = () => bot.entity.position;
    try {
      let i = -1;
      const player0 = bot.players[playerName]?.entity?.position;
      for (const cand of trail.nearestIndices(here(), 64, 4)) {
        const c = trail.get(cand)!;
        // a crumb no closer than the player itself is just the same unreachable goal
        if (player0 && here().distanceTo(new Vec3(c.x, c.y, c.z)) > here().distanceTo(player0) - 3) continue;
        if (here().distanceTo(new Vec3(c.x, c.y, c.z)) < 1.6 || (await go(c))) {
          i = cand;
          break;
        }
        if (isTokenAborted(trailToken)) return false;
      }
      if (i < 0) return false;
      for (let steps = 0; steps < 300 && !isTokenAborted(trailToken) && instance.status === "online"; steps++) {
        const p = bot.players[playerName]?.entity;
        if (!p || !bot.entity) return false;
        if (here().distanceTo(p.position) <= holdDist + 1.5) return true;
        const c = trail.get(i);
        if (!c) return false;
        if (c.jumpTo) {
          if (Math.hypot(here().x - c.x, here().z - c.z) > 0.9) await go(c, true);
          const jumped = await tryReplayObservedJump(
            instance,
            { from: c, to: c.jumpTo, at: Date.now() },
            trailToken,
            (pr) => throttledReport(pr.label ?? "parkour")
          );
          if (!jumped) return false;
          i++;
          continue;
        }
        const k = trail.nextIndex(i, 6);
        if (k === i) return true; // end of the route: normal follow takes over
        if (await go(trail.get(k)!)) {
          i = k;
          continue;
        }
        if (k > i + 1 && (await go(trail.get(i + 1)!))) {
          i++;
          continue;
        }
        return false;
      }
      return false;
    } finally {
      trailActive = false;
    }
  };
  let jumpTakeoff: { x: number; y: number; z: number } | null = null;
  let prevPlayerGround = true;
  let teleportedAt = 0;
  let teleportHandled = 0;
  const onTeleport = () => {
    teleportedAt = Date.now();
    if (trailActive) trailAbort = true;
    wantTrail = false;
    lastTrailAt = 0;
    budget = 0;
    if (instance.bot) setSearchBudget(instance.bot, 0);
  };
  const tpBot = instance.bot;
  tpBot?.on(TELEPORT_EVENT as never, onTeleport as never);

  try {
    while (!token.cancelled) {
      const bot = requireBot(instance);
      if ((bot.health ?? 0) <= 0 || !bot.entity) throw new Error("Bot died — follow stopped.");

      let tracked = bot.players[playerName]?.entity ?? null;
      if (!tracked) {
        throttledReport(`${playerName} not visible — bekleniyor`);
        await sleep(1200);
        if (instance.status !== "online") throw new Error("Connection lost — follow ended.");
        continue;
      }

      restoreFollowMovement();

      let lastPos = bot.entity.position.clone();
      let lastMoveAt = Date.now();
      let consecutiveStucks = 0;
      let lastHopAt = 0;
      let scaffoldUntil = 0;
      let lastNoPathAt = 0;
      let lastGapAttemptAt = 0;
      let lastApproachScan = 0;
      let approach: { x: number; y: number; z: number } | null = null;

      const applyFollowGoal = (ent: Entity, forceApproach = false) => {
        // never re-aim in mid-jump: setGoal lets go of every key and the jump fell short
        const e = bot.entity as (typeof bot.entity & { isInWater?: boolean }) | undefined;
        if (e && !e.onGround && !e.isInWater && !onLadderNow(bot)) {
          whenGrounded(bot, () => {
            if (bot.entity?.onGround) applyFollowGoalNow(ent, forceApproach);
          });
          return;
        }
        applyFollowGoalNow(ent, forceApproach);
      };
      const applyFollowGoalNow = (ent: Entity, forceApproach = false) => {
        const botPos = bot.entity?.position;
        const botY = botPos?.y ?? 0;
        const dy = ent.position.y - botY;
        const xz = botPos ? Math.hypot(ent.position.x - botPos.x, ent.position.z - botPos.z) : 99;
        if (dy >= 2.5 && xz < 14) {
          if (forceApproach || !approach || Date.now() - lastApproachScan > 10_000) {
            lastApproachScan = Date.now();
            approach = findElevatedApproach(bot, ent.position);
            instance.getLogger().debug("Follow approach", approach ? `${approach.x},${approach.y},${approach.z}` : "none");
          }
          if (approach) {
            const dAp = Math.hypot(
              (bot.entity?.position.x ?? 0) - (approach.x + 0.5),
              (bot.entity?.position.z ?? 0) - (approach.z + 0.5)
            );
            const yAp = Math.abs((bot.entity?.position.y ?? 0) - approach.y);
            if (dAp < 1.7 && yAp < 1.6) {
              approach = null;
              bot.pathfinder.setGoal(followGoal(ent, holdDist, bot), true);
              return;
            }
            bot.pathfinder.setGoal(new goals.GoalNear(approach.x, approach.y, approach.z, 1), false);
            return;
          }
        } else {
          approach = null;
        }
        const curGoal = bot.pathfinder.goal as GoalFollowAtHeight | { entity?: Entity } | undefined;
        if (!forceApproach && curGoal instanceof GoalFollowAtHeight && curGoal.entity === ent) return;
        bot.pathfinder.setGoal(followGoal(ent, holdDist, bot), true);
      };

      try {
        applyFollowGoal(tracked);
      } catch {
        /* */
      }

      const onPath = (result: { status: string; path?: unknown[]; time?: number; visitedNodes?: number }) => {
        lastPathStatus = result.status;
        if (trailActive) return;
        if (result.status !== "success" && result.path && bot.entity) {
          // no full route: never walk a best-effort path down into a place we cannot leave
          const live0 = bot.players[playerName]?.entity;
          const by = bot.entity.position.y;
          const py = live0?.position.y ?? by;
          // While a long search is still running ("partial") only an irreversible drop is cut;
          // once no route exists, do not go down at all unless the player is down there.
          const floorY =
            result.status === "partial" ? Math.min(by, py) - 1.5 : py < by - 1 ? py - 1.5 : by - 0.5;
          const before = result.path.length;
          if (cutPathAtDrop(result.path as Array<{ y: number }>, floorY) < before && Date.now() - lastCutLogAt > 5000) {
            lastCutLogAt = Date.now();
            instance.getLogger().debug("Follow path", `partial path cut before a drop (${before} → ${result.path.length}) ${(result.path as Array<{ x: number; y: number; z: number; parkour?: boolean }>).map((n) => `${n.x},${n.y},${n.z}${n.parkour ? "P" : ""}`).join(" ")}`);
          }
        }
        if (result.status !== "success" && result.status !== "partial") {
          instance.getLogger().debug("Follow path", `${result.status} nodes=${result.visitedNodes ?? "?"} t=${Math.round(result.time ?? 0)}ms len=${result.path?.length ?? 0}`);
        }
        if (result.status !== "noPath" && result.status !== "timeout") return;
        if (budget < SEARCH_BUDGETS.length - 1) {
          // nothing within this detour budget: widen and plan the same goal again;
          // do not walk the best-effort path meanwhile (it stepped off a beam)
          if (result.path) result.path.length = 0;
          budget++;
          setSearchBudget(bot, budget);
          setImmediate(() =>
            whenGrounded(bot, () => {
              const g = bot.pathfinder.goal;
              if (!g || isParkourLocked(bot)) return;
              try {
                bot.pathfinder.setGoal(g, g instanceof GoalFollowAtHeight);
              } catch {
                /* */
              }
            })
          );
          return;
        }
        if (isParkourLocked(bot)) return;
        if (trail.size > 0 && Date.now() - lastTrailAt > 6000) {
          wantTrail = true; // best option first: the route the player used
          return;
        }
        if (Date.now() - lastNoPathAt < 4000) return;
        lastNoPathAt = Date.now();
        const live = bot.players[playerName]?.entity;
        if (!live || !bot.entity) return;
        void (async () => {
          if (isParkourLocked(bot)) return;
          if (await tryPassNearbyDoor(instance)) {
            throttledReport(`follow: ${playerName} · door passed`);
            restoreFollowMovement();
            applyFollowGoal(live);
            return;
          }
          const replay = findReplayJump(bot, observedJumps);
          if (replay) {
            lastGapAttemptAt = Date.now();
            if (await tryReplayObservedJump(instance, replay, token, (p) => throttledReport(p.label ?? "parkour"))) {
              throttledReport(`follow: ${playerName} · copied jump`);
              restoreFollowMovement();
              applyFollowGoal(live);
              return;
            }
          }
          lastGapAttemptAt = Date.now();
          if (await tryJumpAcrossToPlayer(instance, live, token, (p) => throttledReport(p.label ?? "parkour"), { force: true })) {
            throttledReport(`follow: ${playerName} · jump to player`);
            restoreFollowMovement();
            applyFollowGoal(live);
            return;
          }
          // walk to the lip facing the player and take one configured gap jump
          if (
            await tryGapJumpTowardPoint(
              instance,
              { x: live.position.x, y: live.position.y, z: live.position.z },
              token,
              (lx, ly, lz) => pathfinderGoal(instance, new goals.GoalBlock(lx, ly, lz), token, { timeoutMs: 12_000 }),
              (p) => throttledReport(p.label ?? "parkour")
            )
          ) {
            throttledReport(`follow: ${playerName} · gap jump`);
            restoreFollowMovement();
            applyFollowGoal(live);
            return;
          }
          if (enableScaffoldForStuck(bot)) {
            throttledReport(`follow: ${playerName} · no path — bridging…`);
            scaffoldUntil = Date.now() + 20_000;
          } else {
            throttledReport(`follow: ${playerName} · no reachable natural path`);
          }
          applyFollowGoal(live, true);
        })();
      };
      bot.on("path_update", onPath);

      try {
        const followEpoch = instance.controlEpoch;
        while (!isTokenAborted(token) && instance.controlEpoch === followEpoch && instance.status === "online") {
          if ((bot.health ?? 0) <= 0 || !bot.entity) {
            clearGoal(bot);
            throw new Error("Bot died — follow stopped.");
          }
          if (isParkourLocked(bot)) {
            await sleep(40);
            continue;
          }
          if (instance.survival?.fallGuard?.holdsMovement?.()) {
            clearGoal(bot);
            await sleep(40);
            continue;
          }
          const cur = bot.players[playerName]?.entity ?? null;
          if (!cur || cur !== tracked) {
            tracked = cur;
            break;
          }

          pruneObservedJumps(observedJumps);
          const playerGround = cur.onGround !== false;
          if (prevPlayerGround && !playerGround) {
            jumpTakeoff = { x: cur.position.x, y: cur.position.y, z: cur.position.z };
          } else if (!prevPlayerGround && playerGround && jumpTakeoff) {
            const landing = { x: cur.position.x, y: cur.position.y, z: cur.position.z };
            pushObservedJump(observedJumps, jumpTakeoff, landing);
            if (Math.hypot(landing.x - jumpTakeoff.x, landing.z - jumpTakeoff.z) >= 1.7) trail.recordJump(jumpTakeoff, landing);
            jumpTakeoff = null;
          }
          prevPlayerGround = playerGround;
          trail.record(
            cur.position,
            playerGround || isClimbable(blockNameAt(bot, cur.position.x, cur.position.y, cur.position.z))
          );

          if (teleportedAt > teleportHandled) {
            // plan from the new spot; old stuck timers and approach points are stale
            teleportHandled = teleportedAt;
            approach = null;
            consecutiveStucks = 0;
            lastMoveAt = Date.now();
            lastPos = bot.entity.position.clone();
            lastPathStatus = "";
            applyFollowGoal(cur, true);
          }

          if (wantTrail && !trailActive) {
            wantTrail = false;
            lastTrailAt = Date.now();
            const walked = await walkTrail();
            if (walked) consecutiveStucks = 0;
            // a route that did not work: let the other fallbacks have a turn first
            else lastTrailAt = Date.now() + 24_000;
            budget = 0;
            setSearchBudget(bot, 0);
            ensureMovement(instance, { mode: "follow", canDig: movementPolicy?.canDig ?? false, canOpenDoors: true, allowPlace: movementPolicy?.allowPlace ?? false });
            applyFollowGoal(cur, true);
            lastMoveAt = Date.now();
            lastPos = bot.entity.position.clone();
            await sleep(FOLLOW_TICK_MS);
            continue;
          }

          if (!pfIsMoving(bot) && bot.entity.onGround) {
            try {
              await stepLookAtEntity(bot, cur, turnSpeed(instance));
            } catch {
              /* */
            }
          }

          const d = bot.entity.position.distanceTo(cur.position);
          const pos = bot.entity.position;
          if (budget > 0 && d <= holdDist + 1.5) {
            budget = 0;
            setSearchBudget(bot, 0);
          }

          if (bot.entity.onGround && Date.now() - lastGapAttemptAt > 700) {
            const replay = findReplayJump(bot, observedJumps);
            if (replay) {
              lastGapAttemptAt = Date.now();
              throttledReport(`follow: ${playerName} · copying jump`);
              clearGoal(bot);
              const jumped = await tryReplayObservedJump(instance, replay, token, (p) =>
                throttledReport(p.label ?? "parkour")
              );
              restoreFollowMovement();
              if (jumped) consecutiveStucks = 0;
              applyFollowGoal(cur);
              await sleep(FOLLOW_TICK_MS);
              continue;
            }
          }

          // Already waiting on the far side: jump to their platform, do not path under them.
          if (
            bot.entity.onGround &&
            !pfIsMoving(bot) &&
            d > holdDist + 0.8 &&
            Date.now() - lastGapAttemptAt > 900 &&
            moveCfg(instance).allowParkour !== false
          ) {
            lastGapAttemptAt = Date.now();
            const jumped = await tryJumpAcrossToPlayer(instance, cur, token, (p) =>
              throttledReport(p.label ?? "parkour")
            );
            if (jumped) {
              throttledReport(`follow: ${playerName} · jump to player`);
              restoreFollowMovement();
              consecutiveStucks = 0;
              applyFollowGoal(cur);
              await sleep(FOLLOW_TICK_MS);
              continue;
            }
          }

          // The follow goal only moves when the player moved 4+ blocks (so long detours
          // are not restarted). Standing still short of a player who stopped 3 blocks
          // further on waited for the 10 s stuck watchdog: re-aim at where they are now.
          if (
            bot.entity.onGround &&
            !pfIsMoving(bot) &&
            d > holdDist + 1 &&
            Date.now() - lastGoalRefreshAt > 1000 &&
            lastPathStatus === "success" &&
            !isParkourLocked(bot)
          ) {
            lastGoalRefreshAt = Date.now();
            applyFollowGoal(cur, true);
          }

          if (pos.distanceTo(lastPos) > 0.35) {
            lastPos = pos.clone();
            lastMoveAt = Date.now();
            consecutiveStucks = 0;
            if (scaffoldUntil > 0 && Date.now() > scaffoldUntil) {
              scaffoldUntil = 0;
              restoreFollowMovement();
              applyFollowGoal(cur);
            }
          } else if (d > holdDist + 0.6 && Date.now() - lastMoveAt > FOLLOW_STUCK_MS) {
            lastMoveAt = Date.now();
            consecutiveStucks++;

            if (consecutiveStucks >= 2 && onLadderNow(bot) && isTurningLadder(bot)) {
              throttledReport(`follow: ${playerName} · turning ladder`);
              consecutiveStucks = 0;
              applyFollowGoal(cur, true);
            } else if (
              consecutiveStucks >= 2 &&
              Date.now() - lastHopAt > LADDER_HOP_COOLDOWN_MS &&
              onLadderNow(bot)
            ) {
              lastHopAt = Date.now();
              throttledReport(`follow: ${playerName} · trying ladder jump…`);
              clearGoal(bot);
              try {
                await ladderHopAssist(bot, cur);
              } catch {
                /* */
              }
            } else if (consecutiveStucks >= 2 && trail.size > 0 && Date.now() - lastTrailAt > 6000) {
              wantTrail = true;
            } else if (consecutiveStucks >= 2 && !onLadderNow(bot) && !isParkourLocked(bot)) {
              const openedDoor = await tryPassNearbyDoor(instance);
              if (openedDoor) {
                throttledReport(`follow: ${playerName} · door passed`);
                restoreFollowMovement();
                consecutiveStucks = 0;
              } else {
                const replay = findReplayJump(bot, observedJumps);
                lastGapAttemptAt = Date.now();
                if (replay && (await tryReplayObservedJump(instance, replay, token, (p) => throttledReport(p.label ?? "parkour")))) {
                  throttledReport(`follow: ${playerName} · copied jump`);
                  restoreFollowMovement();
                  consecutiveStucks = 0;
                } else if (await tryJumpAcrossToPlayer(instance, cur, token, (p) => throttledReport(p.label ?? "parkour"), { force: true })) {
                  throttledReport(`follow: ${playerName} · jump to player`);
                  restoreFollowMovement();
                  consecutiveStucks = 0;
                } else if (enableScaffoldForStuck(bot)) {
                  throttledReport(`follow: ${playerName} · stuck — bridging…`);
                  scaffoldUntil = Date.now() + 25_000;
                } else {
                  throttledReport(`follow: ${playerName} · inaccessible point skipped`);
                }
              }
            } else {
              throttledReport(`follow: ${playerName} · stuck — holding route`);
            }

            applyFollowGoal(cur, consecutiveStucks >= 2);
          }

          throttledReport(`follow: ${playerName} · ${Math.round(d)}m (target ${holdDist}m)`);
          await sleep(FOLLOW_TICK_MS);
        }
      } finally {
        bot.removeListener("path_update", onPath);
      }

      clearGoal(bot);
      if (instance.status !== "online") throw new Error("Connection lost — follow ended.");
    }
  } finally {
    tpBot?.removeListener(TELEPORT_EVENT as never, onTeleport as never);
    const b = instance.bot;
    if (b) {
      clearGoal(b);
      resetSearchBudget(b);
    }
  }
}

export function stopCreativeFlight(bot: Bot) {
  const phys = (bot as unknown as { physics?: { gravity?: number | null } }).physics;
  const g = phys?.gravity;
  // mineflayer stopFlying() assigns saved gravity; if fly never started that
  // value is null and the bot floats through gaps (looks like a cheat).
  if (g === 0 || g == null || (typeof g === "number" && g < 0.01)) {
    try {
      (bot as unknown as { creative?: { stopFlying?(): void } }).creative?.stopFlying?.();
    } catch {
      /* */
    }
    if (phys && (phys.gravity == null || phys.gravity === 0 || (typeof phys.gravity === "number" && phys.gravity < 0.01))) {
      phys.gravity = 0.08;
    }
  }
  try {
    const v = bot.entity?.velocity;
    if (v) {
      v.x = 0;
      v.y = 0;
      v.z = 0;
    }
  } catch {
    /* */
  }
}

/** Leave farm/creative-fly settings so follow/goto can walk again. */
export function restoreDefaultMovement(instance: BotInstance) {
  const bot = instance.bot;
  if (!bot) return;
  stopCreativeFlight(bot);
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
  try {
    ensureMovement(instance, { mode: "goto" });
  } catch {
    /* */
  }
}

export function stopMovement(instance: BotInstance) {
  instance.tasks.cancelAll("stopped by user");
  const bot = instance.bot;
  if (!bot) return;
  stopCreativeFlight(bot);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function followGoal(entity: Entity, range: number, bot?: Bot) {
  if (!bot) return new GoalFollowAtHeight(entity, range);
  return new GoalFollowAtHeight(entity, range, () => {
    const e = bot.entity as (typeof bot.entity & { isInWater?: boolean }) | undefined;
    return !e || e.onGround || Boolean(e.isInWater) || onLadderNow(bot);
  });
}

export { runParkourGoto, executeGapJump, climbLadderParkour, findGapLanding } from "./parkour";
export { stepLookAtEntity, easeLookAt, stepLookAt, entityLookPoint } from "./look";

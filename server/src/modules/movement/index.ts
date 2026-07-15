import type { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken, ProgressFn } from "../../core/TaskQueue";
import type { MovementConfig } from "../../types";
import { easeLookAt, entityLookPoint, stepLookAtEntity } from "./look";
import { installWaterMovementAssist } from "./water";

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
const LADDER_HOP_COOLDOWN_MS = 5_000;

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline — cannot run movement task.");
  return bot;
}

function moveCfg(instance: BotInstance): MovementConfig {
  return instance.config.movement;
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
  /** true → parkur zorla açık (config'i ezer) */
  parkour?: boolean;
  /** takip for canDig kapatılır (başkasının parkurunu/haritasını kazmasın) */
  canDig?: boolean;
  /** blok place (scaffold). Takipte varsayılan KAPALI — merdiven/parkurda
   *  konan blok botu sıkıştırıyor ve haritayı bozuyordu. */
  allowPlace?: boolean;
  /** "follow": canDig=false + allowPlace=false varsayılır */
  mode?: "follow" | "goto" | "parkour";
}

/** pathfinder eklentisini yükle + Movements'ı config'ten kur */
export function ensureMovement(instance: BotInstance, opts?: EnsureMovementOpts): Bot {
  const bot = requireBot(instance);
  const anyBot = bot as unknown as { pathfinder?: unknown };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);
  // caya-water-movement-stability-v1: akıntı, yüzey ve kıyıya çıkış stabilizasyonu.
  installWaterMovementAssist(bot);

  const cfg = moveCfg(instance);
  const movements = new Movements(bot);

  const digDefault = opts?.mode === "follow" ? false : Boolean(cfg.canDig);
  movements.canDig = opts?.canDig !== undefined ? opts.canDig : digDefault;
  movements.allowSprinting = opts?.allowSprintNow !== undefined ? opts.allowSprintNow : cfg.allowSprint !== false;
  // Parkur: pathfinder'ın YERLEŞİK parkuru (1-4 blok boşluk + sprint jump) — merdiven
  // tırmanışı zaten doğal yetenek, ayrı bayrak gerekmez.
  movements.allowParkour = opts?.parkour === true ? true : cfg.allowParkour !== false;
  movements.allow1by1towers = Boolean(cfg.allowTower);
  // DOĞRU özellik adı maxDropDown'dur ("maxDrop" pathfinder'da YOK — eski kod sessizce no-op'tu)
  movements.maxDropDown = Math.max(2, Math.min(6, cfg.maxDrop ?? 4));
  if ("canOpenDoors" in movements) {
    (movements as unknown as { canOpenDoors: boolean }).canOpenDoors = true;
  }

  // DİKKAT: Movements yapıcısı scafoldingBlocks'u KENDİLİĞİNDEN doldurur (dirt/cobble).
  // Placeme istenmiyorsa listeyi BOŞALTMAK şart — atlamak yetmez.
  const placeAllowed = opts?.allowPlace !== undefined ? opts.allowPlace : opts?.mode !== "follow";
  if (!placeAllowed) {
    movements.scafoldingBlocks = [];
  } else {
    const registry = (bot as unknown as { registry: { itemsByName: Record<string, { id: number } | undefined> } })
      .registry;
    const ids = (cfg.scaffoldBlocks ?? [])
      .map((name) => registry?.itemsByName?.[name]?.id)
      .filter((id): id is number => typeof id === "number");
    if (ids.length > 0) movements.scafoldingBlocks = ids;
  }

  bot.pathfinder.setMovements(movements);
  return bot;
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
  opts?: { timeoutMs?: number; onStuckRetry?: () => void }
): Promise<void> {
  const bot = requireBot(instance);
  const timeoutMs = opts?.timeoutMs ?? GOTO_TIMEOUT_MS;

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
      clearInterval(watch);
      clearTimeout(deadline);
      bot.removeListener("goal_reached", onReached);
      bot.removeListener("path_update", onPath);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onReached = () => finish(resolve);
    const onPath = (result: { status: string }) => {
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
      if (token.cancelled) {
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
    parkour: options?.parkour
  });
  if (moveCfg(instance).humanize !== false) await sleep(60 + Math.floor(Math.random() * 120)); // insanî tepki
  if (token.cancelled) throw new Error(token.reason ?? "Task cancelled.");

  await pathfinderGoal(instance, new goals.GoalNear(x, y, z, Math.max(1, range)), token, {
    timeoutMs: options?.timeoutMs,
    onStuckRetry: () => report({ done: 0, total: dist, label: "stuck — recalculating path" })
  });

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
    parkour: options?.parkour
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
  report: ProgressFn
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
  report: ProgressFn
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

  /** Takılınca / noPath: pathfinder'a geçici scaffold ver (config scaffoldBlocks) */
  const enableScaffoldForStuck = (bot: Bot) => {
    ensureMovement(instance, {
      mode: "follow",
      canDig: false,
      allowPlace: true,
      parkour: moveCfg(instance).allowParkour !== false
    });
    // sadece sıkışınca: basamak/kule koyabilsin (sürekli açık değil)
    try {
      const mov = (bot.pathfinder as unknown as { movements?: Movements }).movements;
      if (mov) {
        mov.allow1by1towers = true;
      }
    } catch {
      /* */
    }
  };

  const restoreFollowMovement = () => {
    // normal follow: place kapalı (merdivende rastgele blok spam olmasın)
    ensureMovement(instance, { mode: "follow", allowPlace: false });
  };

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
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(tracked, holdDist), true);
      } catch {
        /* pathfinder bir tık sonra hazır olabilir */
      }

      // iç döngü: goal churn yok. Takılınca: 1) rota tazele 2) merdiven hop
      // 3) hâlâ gidilemiyorsa scaffold ile yeniden path (blok koyarak geç)
      let lastPos = bot.entity.position.clone();
      let lastMoveAt = Date.now();
      let consecutiveStucks = 0;
      let lastHopAt = 0;
      let scaffoldUntil = 0; // scaffold may stay open until this time
      let lastNoPathAt = 0;

      const onPath = (result: { status: string }) => {
        if (result.status !== "noPath") return;
        if (Date.now() - lastNoPathAt < 4000) return;
        lastNoPathAt = Date.now();
        const live = bot.players[playerName]?.entity;
        if (!live || !bot.entity) return;
        // yol yok → blok koyarak path dene (sadece takip takılınca)
        throttledReport(`follow: ${playerName} · no path — bridging…`);
        enableScaffoldForStuck(bot);
        scaffoldUntil = Date.now() + 20_000;
        try {
          bot.pathfinder.setGoal(new goals.GoalFollow(live, holdDist), true);
        } catch {
          /* */
        }
      };
      bot.on("path_update", onPath);

      try {
        while (!token.cancelled && instance.status === "online") {
          if ((bot.health ?? 0) <= 0 || !bot.entity) {
            clearGoal(bot);
            throw new Error("Bot died — follow stopped.");
          }
          const cur = bot.players[playerName]?.entity ?? null;
          if (!cur || cur !== tracked) {
            tracked = cur;
            break;
          }

          // insanî bakış: SADECE dururken
          if (!pfIsMoving(bot) && bot.entity.onGround) {
            try {
              await stepLookAtEntity(bot, cur, turnSpeed(instance));
            } catch {
              /* */
            }
          }

          const d = bot.entity.position.distanceTo(cur.position);
          const pos = bot.entity.position;

          // ilerlediyse scaffold penceresi bitsin → normal takip
          if (pos.distanceTo(lastPos) > 0.35) {
            lastPos = pos.clone();
            lastMoveAt = Date.now();
            consecutiveStucks = 0;
            if (scaffoldUntil > 0 && Date.now() > scaffoldUntil) {
              scaffoldUntil = 0;
              restoreFollowMovement();
              try {
                bot.pathfinder.setGoal(new goals.GoalFollow(cur, holdDist), true);
              } catch {
                /* */
              }
            }
          } else if (d > holdDist + 0.6 && Date.now() - lastMoveAt > FOLLOW_STUCK_MS) {
            lastMoveAt = Date.now();
            consecutiveStucks++;

            if (
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
            } else if (consecutiveStucks >= 2 && !onLadderNow(bot)) {
              // 2. takılma + merdiven değil → scaffold ile yol aç
              throttledReport(`follow: ${playerName} · stuck — bridging…`);
              enableScaffoldForStuck(bot);
              scaffoldUntil = Date.now() + 25_000;
              try {
                bot.pathfinder.setGoal(null);
              } catch {
                /* */
              }
            } else {
              throttledReport(`follow: ${playerName} · stuck — refreshing path`);
              try {
                bot.pathfinder.setGoal(null);
              } catch {
                /* */
              }
            }

            try {
              bot.pathfinder.setGoal(new goals.GoalFollow(cur, holdDist), true);
            } catch {
              /* */
            }
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
    const b = instance.bot;
    if (b) clearGoal(b);
  }
}

export function stopMovement(instance: BotInstance) {
  instance.tasks.cancelAll("stopped by user");
  const bot = instance.bot;
  if (!bot) return;
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

// Deneysel el-yapımı parkur SADECE açık "parkour-goto" aksiyonuyla erişilir —
// normal goto/follow akışına otomatik karışmaz (güvenilirlik for ayrıştırıldı).
export { runParkourGoto, executeGapJump, climbLadderParkour, findGapLanding } from "./parkour";
export { stepLookAtEntity, easeLookAt, stepLookAt, entityLookPoint } from "./look";

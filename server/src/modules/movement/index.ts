import type { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken, ProgressFn } from "../../core/TaskQueue";
import type { MovementConfig } from "../../types";
import { easeLookAt, entityLookPoint, stepLookAtEntity } from "./look";

/**
 * HAREKET ÇEKİRDEĞİ — tek altın kural (TODO §12'ye de yazıldı):
 * mineflayer-pathfinder, aktif bir goal varken DÜMENİN SAHİBİDİR — yürüyüş yönünü
 * kendi verdiği bakış (yaw) ile çizer. Rota aktifken bot.look'a dokunmak botu yanlış
 * yöne yürütür, zıplamaları ıskalatır, merdivenden düşürür ("geri atılma" hatası).
 * İnsanî bakış SADECE bot dururken (pathfinder.isMoving() === false) uygulanır.
 * Aynı sebeple takipte goal sürekli yenilenmez: GoalFollow(dynamic=true) hedefi
 * kendisi izler; yenileme yalnızca entity REFERANSI değişince yapılır.
 */

const GOTO_TIMEOUT_MS = 180_000;
const STUCK_WINDOW_MS = 10_000; // bu süre yer değiştirme yoksa: 1 kez rota tazele, sonra pes et
const FOLLOW_TICK_MS = 150;
const FOLLOW_REPORT_MS = 1500; // panel report en fazla bu sıklıkta (10Hz spam yok)

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot çevrimdışı — hareket görevi çalıştırılamaz.");
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
  /** takip için canDig kapatılır (başkasının parkurunu/haritasını kazmasın) */
  canDig?: boolean;
  /** geriye dönük uyum: "follow" canDig=false varsayar; başka etkisi yok */
  mode?: "follow" | "goto" | "parkour";
}

/** pathfinder eklentisini yükle + Movements'ı config'ten kur */
export function ensureMovement(instance: BotInstance, opts?: EnsureMovementOpts): Bot {
  const bot = requireBot(instance);
  const anyBot = bot as unknown as { pathfinder?: unknown };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);

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

  const registry = (bot as unknown as { registry: { itemsByName: Record<string, { id: number } | undefined> } })
    .registry;
  const ids = (cfg.scaffoldBlocks ?? [])
    .map((name) => registry?.itemsByName?.[name]?.id)
    .filter((id): id is number => typeof id === "number");
  if (ids.length > 0) movements.scafoldingBlocks = ids;

  bot.pathfinder.setMovements(movements);
  return bot;
}

/**
 * Statik hedefe git; söz verir. Bakış müdahalesi YOK — pathfinder sürer.
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
          reject(new Error("Hedefe ulaşan güvenli yol bulunamadı (noPath)."));
        });
      } else if (result.status === "timeout") {
        finish(() => {
          stopGoal();
          reject(new Error("Yol hesaplama zaman aşımına uğradı — hedef çok uzak veya kapalı olabilir."));
        });
      }
    };

    const watch = setInterval(() => {
      if (settled) return;
      if (token.cancelled) {
        finish(() => {
          stopGoal();
          reject(new Error(token.reason ?? "Görev iptal edildi."));
        });
        return;
      }
      if (instance.status !== "online" || !bot.entity) {
        finish(() => reject(new Error("Bağlantı koptu — hareket görevi sonlandı.")));
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
            bot.pathfinder.setGoal(goal); // sıfırdan yeniden hesapla
          } catch {
            /* */
          }
        } else {
          finish(() => {
            stopGoal();
            reject(new Error("İlerleme yok — bot takıldı (rota iki kez hesaplandı, hedefe gidilemiyor)."));
          });
        }
      }
    }, 1000);

    const deadline = setTimeout(() => {
      finish(() => {
        stopGoal();
        reject(new Error("Hedefe zamanında ulaşılamadı (görev zaman aşımı)."));
      });
    }, timeoutMs);

    bot.on("goal_reached", onReached);
    bot.on("path_update", onPath);
    bot.pathfinder.setGoal(goal);
  });
}

export async function runGoto(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  range: number,
  token: TaskToken,
  report: ProgressFn
): Promise<void> {
  const bot = requireBot(instance);
  const dist = Math.round(bot.entity.position.distanceTo({ x, y, z } as never));
  report({ done: 0, total: dist, label: `hedefe gidiliyor (${dist} blok)` });

  ensureMovement(instance, { mode: "goto" });
  if (moveCfg(instance).humanize !== false) await sleep(60 + Math.floor(Math.random() * 120)); // insanî tepki
  if (token.cancelled) throw new Error(token.reason ?? "Görev iptal edildi.");

  await pathfinderGoal(instance, new goals.GoalNear(x, y, z, Math.max(1, range)), token, {
    onStuckRetry: () => report({ done: 0, total: dist, label: "takıldı — rota yeniden hesaplanıyor" })
  });

  // varışta hedefe bak (bot artık DURUYOR — bakış serbest)
  try {
    await easeLookAt(bot, { x, y: y + 1.2, z }, turnSpeed(instance), 8);
  } catch {
    /* */
  }
  report({ done: dist, total: dist, label: "hedefe ulaşıldı" });
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
        ? `${playerName} sunucuda ama görüş menzili dışında — konumu bilinmiyor. Yakınına bir waypoint verip oradan dene.`
        : `${playerName} sunucuda görünmüyor.`
    );
  }
  report({ done: 0, total: 1, label: `${playerName} oyuncusuna gidiliyor` });

  ensureMovement(instance, { mode: "goto" });
  if (moveCfg(instance).humanize !== false) await sleep(60 + Math.floor(Math.random() * 120));
  if (token.cancelled) throw new Error(token.reason ?? "Görev iptal edildi.");

  const p = entity.position;
  await pathfinderGoal(instance, new goals.GoalNear(p.x, p.y, p.z, Math.max(1, range)), token, {
    onStuckRetry: () => report({ done: 0, total: 1, label: "takıldı — rota yeniden hesaplanıyor" })
  });

  const e2 = bot.players[playerName]?.entity;
  if (e2) {
    try {
      await easeLookAt(bot, entityLookPoint(e2), turnSpeed(instance), 10);
    } catch {
      /* */
    }
  }
  report({ done: 1, total: 1, label: `${playerName} yanına ulaşıldı` });
}

/**
 * Sürekli takip. Parkur yapan oyuncuyu da izler: GoalFollow(dynamic=true) hedef
 * hareket ettikçe rotayı KENDİSİ yeniler; allowParkour açıkken atlanabilir
 * boşluklardan atlar, merdivenlere doğal tırmanır. Döngüde goal YENİLENMEZ
 * (path churn zıplama ortasında iptal = boşluğa düşme demekti) — yalnızca entity
 * referansı değişince (menzilden çıkıp girince) bir kez yeniden kurulur.
 * canDig takipte HEP kapalı: bot, birinin parkurunu/haritasını kazarak izlemez.
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

  try {
    while (!token.cancelled) {
      const bot = requireBot(instance);
      if ((bot.health ?? 0) <= 0 || !bot.entity) throw new Error("Bot öldü — takip durdu.");

      let tracked = bot.players[playerName]?.entity ?? null;
      if (!tracked) {
        throttledReport(`${playerName} görünmüyor — bekleniyor`);
        await sleep(1200);
        if (instance.status !== "online") throw new Error("Bağlantı koptu — takip sonlandı.");
        continue;
      }

      ensureMovement(instance, { mode: "follow" });
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(tracked, holdDist), true);
      } catch {
        /* pathfinder bir tık sonra hazır olabilir */
      }

      // iç döngü: aynı entity referansı geçerli olduğu sürece goal'a DOKUNMA
      while (!token.cancelled && instance.status === "online") {
        if ((bot.health ?? 0) <= 0 || !bot.entity) {
          clearGoal(bot);
          throw new Error("Bot öldü — takip durdu.");
        }
        const cur = bot.players[playerName]?.entity ?? null;
        if (!cur || cur !== tracked) {
          tracked = cur; // kayboldu ya da referans tazelendi → dış döngü yeniden kurar
          break;
        }

        // insanî bakış: SADECE dururken (mesafedeyken oyuncuya bakar; yürürken pathfinder sürer)
        if (!pfIsMoving(bot) && bot.entity.onGround) {
          try {
            await stepLookAtEntity(bot, cur, turnSpeed(instance));
          } catch {
            /* */
          }
        }

        const d = bot.entity.position.distanceTo(cur.position);
        throttledReport(`takip: ${playerName} · ${d.toFixed(1)}m (hedef ${holdDist}m)`);
        await sleep(FOLLOW_TICK_MS);
      }

      clearGoal(bot);
      if (instance.status !== "online") throw new Error("Bağlantı koptu — takip sonlandı.");
    }
  } finally {
    const b = instance.bot;
    if (b) clearGoal(b);
  }
}

export function stopMovement(instance: BotInstance) {
  instance.tasks.cancelAll("kullanıcı durdurdu");
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
// normal goto/follow akışına otomatik karışmaz (güvenilirlik için ayrıştırıldı).
export { runParkourGoto, executeGapJump, climbLadderParkour, findGapLanding } from "./parkour";
export { stepLookAtEntity, easeLookAt, stepLookAt, entityLookPoint } from "./look";

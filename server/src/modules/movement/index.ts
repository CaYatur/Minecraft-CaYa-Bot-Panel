import type { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken, ProgressFn } from "../../core/TaskQueue";
import type { MovementConfig } from "../../types";
import { easeLookAt, entityLookPoint, stepLookAlongMotion, stepLookAtEntity } from "./look";

const GOTO_TIMEOUT_MS = 180_000;

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot çevrimdışı — hareket görevi çalıştırılamaz.");
  return bot;
}

function moveCfg(instance: BotInstance): MovementConfig {
  return instance.config.movement;
}

/** İnsanî dönüş hızı (°/tick) — yüksek değer AC flag riski */
function turnSpeed(instance: BotInstance): number {
  const c = moveCfg(instance);
  return Math.max(8, Math.min(28, c.lookTurnDegPerTick ?? 16));
}

/**
 * Pathfinder Movements:
 * - follow/goto: allowParkour config’ten AÇIK (atlanabilir boşluklardan atlansın)
 * - maxDrop: takipte ürkek düşme yok (config maxDrop, genelde 3)
 * - parkour-goto: daha agresif maxDrop + gap jump yedek
 * - Bakış path ile yarışırsa 1-up “geri at” olabilir — goto’da bakış yumuşak/sadece yerde
 */
export function ensureMovement(
  instance: BotInstance,
  opts?: { allowSprintNow?: boolean; parkour?: boolean; mode?: "follow" | "goto" | "parkour" }
): Bot {
  const bot = requireBot(instance);
  const anyBot = bot as unknown as { pathfinder?: { setMovements(m: unknown): void } };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);

  const cfg = moveCfg(instance);
  const mode = opts?.mode ?? (opts?.parkour ? "parkour" : "goto");
  // Parkur açık: config allowParkour (varsayılan true). Kapalıysa sadece yürüyüş/1-up.
  const parkourOn =
    mode === "parkour" || opts?.parkour === true ? true : cfg.allowParkour !== false;

  const movements = new Movements(bot);
  movements.canDig = Boolean(cfg.canDig);
  const sprintAllowed =
    opts?.allowSprintNow !== undefined ? opts.allowSprintNow : cfg.allowSprint !== false;
  movements.allowSprinting = Boolean(sprintAllowed);
  movements.allowParkour = parkourOn;
  movements.allow1by1towers = Boolean(cfg.allowTower);

  try {
    const baseDrop = Math.max(1, Math.min(6, cfg.maxDrop ?? 3));
    // parkour-goto: biraz daha serbest drop; follow/goto: config (atlanır, uçuruma atılmaz)
    (movements as { maxDrop?: number }).maxDrop =
      mode === "parkour"
        ? Math.max(baseDrop, Math.min(8, (cfg.parkourMaxGap ?? 3) + 2))
        : Math.min(4, baseDrop);
  } catch {
    /* */
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

function pathfinderGoal(
  instance: BotInstance,
  goal: goals.Goal,
  token: TaskToken,
  timeoutMs = GOTO_TIMEOUT_MS,
  lookTarget?: { x: number; y: number; z: number } | (() => { x: number; y: number; z: number } | null),
  moveMode: "follow" | "goto" | "parkour" = "goto"
): Promise<void> {
  const bot = ensureMovement(instance, {
    allowSprintNow: moveCfg(instance).allowSprint !== false,
    // parkour mode zorla açık; goto/follow config’ten (allowParkour)
    parkour: moveMode === "parkour" ? true : undefined,
    mode: moveMode
  });
  const reaction = moveCfg(instance).humanize === false || moveMode === "parkour" ? 0 : 40 + Math.floor(Math.random() * 90);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const stopGoal = () => {
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
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onReached = () => finish(() => resolve());
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

    const start = async () => {
      if (reaction > 0) await sleep(reaction);
      if (token.cancelled) {
        finish(() => reject(new Error(token.reason ?? "Görev iptal edildi.")));
        return;
      }
      bot.pathfinder.setGoal(goal);
    };
    void start();

    const watch = setInterval(() => {
      if (settled) return;
      if (token.cancelled) {
        finish(() => {
          stopGoal();
          reject(new Error(token.reason ?? "Görev iptal edildi."));
        });
        return;
      }
      if (instance.status !== "online") {
        finish(() => reject(new Error("Bağlantı koptu — hareket görevi sonlandı.")));
        return;
      }
      // Goto: hafif bakış (pathfinder look ile yarışmasın diye yavaş + sadece yerde)
      if (moveMode === "parkour") return;
      if (!bot.entity?.onGround) return;
      void (async () => {
        try {
          const lt = typeof lookTarget === "function" ? lookTarget() : lookTarget;
          if (lt) await stepLookAlongMotion(bot, lt, Math.min(12, turnSpeed(instance)));
        } catch {
          /* */
        }
      })();
    }, 200);

    const deadline = setTimeout(() => {
      finish(() => {
        stopGoal();
        reject(new Error("Hedefe zamanında ulaşılamadı (görev zaman aşımı)."));
      });
    }, timeoutMs);

    bot.on("goal_reached", onReached);
    bot.on("path_update", onPath);
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
  ensureMovement(instance, {
    allowSprintNow: moveCfg(instance).allowSprint !== false,
    mode: "goto"
  });
  try {
    await pathfinderGoal(
      instance,
      new goals.GoalNear(x, y, z, Math.max(1, range)),
      token,
      GOTO_TIMEOUT_MS,
      { x, y, z },
      "goto"
    );
  } catch (e) {
    // noPath → gelişmiş parkur (izole; normal takibi bozmaz)
    const msg = e instanceof Error ? e.message : String(e);
    const parkour = moveCfg(instance).allowParkour !== false;
    if (parkour && (msg.includes("noPath") || msg.includes("yol") || msg.includes("zaman"))) {
      const { runParkourGoto } = await import("./parkour.js");
      report({ done: 0, total: dist, label: `parkur deneniyor…` });
      await runParkourGoto(instance, x, y, z, range, token, report);
    } else {
      throw e;
    }
  }
  try {
    await easeLookAt(bot, { x, y: y + 1.2, z }, turnSpeed(instance), 8);
  } catch {
    /* */
  }
  report({ done: dist, total: dist, label: "hedefe ulaşıldı" });
}

export { runParkourGoto, executeGapJump, climbLadderParkour, findGapLanding } from "./parkour.js";

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
  const p = entity.position;
  ensureMovement(instance, {
    allowSprintNow: moveCfg(instance).allowSprint !== false,
    mode: "goto"
  });

  try {
    await pathfinderGoal(
      instance,
      new goals.GoalNear(p.x, p.y, p.z, Math.max(1, range)),
      token,
      GOTO_TIMEOUT_MS,
      () => {
        const e = bot.players[playerName]?.entity;
        return e ? entityLookPoint(e) : { x: p.x, y: p.y + 1.5, z: p.z };
      },
      "goto"
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const parkour = moveCfg(instance).allowParkour !== false;
    if (parkour && (msg.includes("noPath") || msg.includes("yol") || msg.includes("zaman"))) {
      const { runParkourGoto } = await import("./parkour.js");
      report({ done: 0, total: 1, label: `parkur → ${playerName}` });
      await runParkourGoto(instance, p.x, p.y, p.z, range, token, report, {
        liveTarget: () => {
          const e = bot.players[playerName]?.entity;
          if (!e) return null;
          return { x: e.position.x, y: e.position.y, z: e.position.z };
        }
      });
    } else {
      throw e;
    }
  }
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
 * Sürekli takip: GoalFollow + sprint + hedefe bakış.
 * Pathfinder parkour config’ten açık → atlanabilir boşluklardan atlar (safe-only değil).
 * Özel merdiven kilidi / kenar geri-çek YOK (eski “geri geri at” spam’ini tetiklemez).
 */
export async function runFollow(
  instance: BotInstance,
  playerName: string,
  distance: number,
  token: TaskToken,
  report: ProgressFn
): Promise<void> {
  const holdDist = Math.max(1, Math.min(16, distance));
  const distJitter = () => holdDist + (Math.random() * 0.35 - 0.1);
  const canSprint = () => moveCfg(instance).allowSprint !== false;
  const parkourOn = () => moveCfg(instance).allowParkour !== false;

  const clearGoal = (bot: Bot) => {
    try {
      const pf = bot.pathfinder as { setGoal?(g: null): void; stop?(): void };
      try {
        pf?.stop?.();
      } catch {
        /* */
      }
      pf?.setGoal?.(null);
    } catch {
      /* */
    }
    for (const k of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
      try {
        bot.setControlState(k, false);
      } catch {
        /* */
      }
    }
  };

  try {
    while (!token.cancelled) {
      const bot = requireBot(instance);
      if ((bot.health ?? 0) <= 0 || !bot.entity) {
        clearGoal(bot);
        throw new Error("Bot öldü — takip durdu");
      }

      const entity = bot.players[playerName]?.entity;
      if (entity) {
        report({
          done: 0,
          total: 0,
          label: `${playerName} takip (${holdDist}m)${parkourOn() ? " · parkur" : ""}`
        });

        ensureMovement(instance, {
          allowSprintNow: canSprint(),
          mode: "follow"
          // parkour: config allowParkour (varsayılan açık)
        });
        const followBot = bot;
        try {
          followBot.pathfinder.setGoal(new goals.GoalFollow(entity, distJitter()), true);
        } catch {
          /* */
        }

        while (!token.cancelled && instance.status === "online") {
          if ((bot.health ?? 0) <= 0 || !bot.entity) {
            clearGoal(followBot);
            throw new Error("Bot öldü — takip durdu");
          }
          const ent = bot.players[playerName]?.entity;
          if (!ent) break;

          const d = bot.entity.position.distanceTo(ent.position);

          if (Math.random() < 0.05) {
            ensureMovement(instance, {
              allowSprintNow: canSprint(),
              mode: "follow"
            });
          }

          if (Math.random() < 0.08) {
            try {
              followBot.pathfinder.setGoal(new goals.GoalFollow(ent, distJitter()), true);
            } catch {
              /* */
            }
          }

          // Zıplarken bakış pathfinder yaw’ını bozmasın (geri-at azaltır)
          const jumping =
            !bot.entity.onGround || (bot.entity.velocity?.y ?? 0) > 0.08;
          if (!jumping) {
            try {
              await stepLookAtEntity(bot, ent, turnSpeed(instance));
            } catch {
              /* */
            }
          }

          report({
            done: 0,
            total: 0,
            label: `takip ${playerName} · ${d.toFixed(1)}m${canSprint() ? " · sprint" : ""}${
              parkourOn() ? " · parkur" : ""
            }`
          });

          await sleep(90 + Math.floor(Math.random() * 50));
        }

        clearGoal(followBot);
      } else {
        report({ done: 0, total: 0, label: `${playerName} görünmüyor — bekleniyor` });
        await sleep(1200 + Math.floor(Math.random() * 400));
      }
      if (instance.status !== "online") throw new Error("Bağlantı koptu — takip sonlandı.");
    }
  } finally {
    try {
      const b = instance.bot;
      if (b) clearGoal(b);
    } catch {
      /* */
    }
  }
}

export function stopMovement(instance: BotInstance) {
  instance.tasks.cancelAll("kullanıcı durdurdu");
  const bot = instance.bot as unknown as {
    pathfinder?: { setGoal(g: null): void };
    clearControlStates?: () => void;
  } | null;
  try {
    bot?.pathfinder?.setGoal(null);
  } catch {
    /* */
  }
  try {
    const b = instance.bot;
    if (b) {
      b.setControlState("forward", false);
      b.setControlState("back", false);
      b.setControlState("left", false);
      b.setControlState("right", false);
      b.setControlState("jump", false);
      b.setControlState("sprint", false);
      b.setControlState("sneak", false);
    }
  } catch {
    /* */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { stepLookAtEntity, easeLookAt, stepLookAt } from "./look";

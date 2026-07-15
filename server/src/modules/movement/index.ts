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
 * pathfinder Movements:
 * - sprint: config.allowSprint (varsayılan açık, takipte de sürekli koşar)
 * - humanize: bakış + maxDrop/kule; sprint’i kısıtlamaz
 */
export function ensureMovement(instance: BotInstance, opts?: { allowSprintNow?: boolean }): Bot {
  const bot = requireBot(instance);
  const anyBot = bot as unknown as { pathfinder?: { setMovements(m: unknown): void } };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);

  const cfg = moveCfg(instance);
  const human = cfg.humanize !== false;
  const movements = new Movements(bot);

  movements.canDig = Boolean(cfg.canDig);
  // allowSprintNow belirtilmezse config; takip/goto her zaman koşabilsin
  const sprintAllowed = opts?.allowSprintNow !== undefined ? opts.allowSprintNow : cfg.allowSprint !== false;
  movements.allowSprinting = Boolean(sprintAllowed);
  // parkour açık kalabilir ama kule + yüksek drop kapatılır (AC)
  movements.allowParkour = Boolean(cfg.allowParkour);
  movements.allow1by1towers = human ? Boolean(cfg.allowTower) : true;

  try {
    (movements as { maxDrop?: number }).maxDrop = human ? Math.min(4, cfg.maxDrop ?? 3) : 256;
  } catch {
    /* eski pathfinder */
  }

  const registry = (bot as unknown as { registry: { itemsByName: Record<string, { id: number } | undefined> } }).registry;
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
  lookTarget?: { x: number; y: number; z: number } | (() => { x: number; y: number; z: number } | null)
): Promise<void> {
  const bot = ensureMovement(instance);
  // kısa insanî gecikme — anında yola çıkma flag’i azaltır
  const reaction = moveCfg(instance).humanize === false ? 0 : 40 + Math.floor(Math.random() * 90);

  return new Promise<void>((resolve, reject) => {
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
    const onReached = () => {
      cleanup();
      resolve();
    };
    const onPath = (result: { status: string }) => {
      if (result.status === "noPath") {
        cleanup();
        stopGoal();
        reject(new Error("Hedefe ulaşan güvenli yol bulunamadı (noPath)."));
      } else if (result.status === "timeout") {
        cleanup();
        stopGoal();
        reject(new Error("Yol hesaplama zaman aşımına uğradı — hedef çok uzak veya kapalı olabilir."));
      }
    };

    const start = async () => {
      if (reaction > 0) await sleep(reaction);
      if (token.cancelled) {
        reject(new Error(token.reason ?? "Görev iptal edildi."));
        return;
      }
      bot.pathfinder.setGoal(goal);
    };
    void start();

    const watch = setInterval(() => {
      if (token.cancelled) {
        cleanup();
        stopGoal();
        reject(new Error(token.reason ?? "Görev iptal edildi."));
        return;
      }
      if (instance.status !== "online") {
        cleanup();
        reject(new Error("Bağlantı koptu — hareket görevi sonlandı."));
        return;
      }
      // yumuşak bakış: hedef / hareket yönü (pathfinder kafa snap’ini ezer)
      void (async () => {
        try {
          const lt = typeof lookTarget === "function" ? lookTarget() : lookTarget;
          if (lt) await stepLookAlongMotion(bot, lt, turnSpeed(instance));
          else await stepLookAlongMotion(bot, null, turnSpeed(instance));
        } catch {
          /* look fail ignore */
        }
      })();
    }, 120);

    const deadline = setTimeout(() => {
      cleanup();
      stopGoal();
      reject(new Error("Hedefe zamanında ulaşılamadı (görev zaman aşımı)."));
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
  ensureMovement(instance, { allowSprintNow: moveCfg(instance).allowSprint !== false });
  await pathfinderGoal(
    instance,
    new goals.GoalNear(x, y, z, Math.max(1, range)),
    token,
    GOTO_TIMEOUT_MS,
    { x, y, z }
  );
  // varınca hedefe doğru bak
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
  const p = entity.position;
  ensureMovement(instance, { allowSprintNow: moveCfg(instance).allowSprint !== false });

  // giderken periyodik bakış entity’ye
  await pathfinderGoal(
    instance,
    new goals.GoalNear(p.x, p.y, p.z, Math.max(1, range)),
    token,
    GOTO_TIMEOUT_MS,
    () => {
      const e = bot.players[playerName]?.entity;
      return e ? entityLookPoint(e) : { x: p.x, y: p.y + 1.5, z: p.z };
    }
  );
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
 * Sürekli takip: pathfinder GoalFollow + her tick hedefe yumuşak bakış.
 * Sprint config.allowSprint ile sürekli açık (yetişmek için).
 */
export async function runFollow(
  instance: BotInstance,
  playerName: string,
  distance: number,
  token: TaskToken,
  report: ProgressFn
): Promise<void> {
  const holdDist = Math.max(1, Math.min(16, distance));
  // hafif jitter — robotik sabit mesafe flag’i azaltır
  const distJitter = () => holdDist + (Math.random() * 0.35 - 0.1);
  const canSprint = () => moveCfg(instance).allowSprint !== false;

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
    for (const k of ["forward", "back", "left", "right", "jump", "sprint"] as const) {
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
      // ölüm / entity yok: pathfinder kilitlenmesin
      if ((bot.health ?? 0) <= 0 || !bot.entity) {
        clearGoal(bot);
        throw new Error("Bot öldü — takip durdu");
      }

      const entity = bot.players[playerName]?.entity;
      if (entity) {
        report({ done: 0, total: 0, label: `${playerName} takip (${holdDist}m) · bakış · sprint` });

        ensureMovement(instance, { allowSprintNow: canSprint() });
        const followBot = bot;
        try {
          followBot.pathfinder.setGoal(new goals.GoalFollow(entity, distJitter()), true);
        } catch {
          /* */
        }

        // bakış + hedef yenileme döngüsü
        while (!token.cancelled && instance.status === "online") {
          if ((bot.health ?? 0) <= 0 || !bot.entity) {
            clearGoal(followBot);
            throw new Error("Bot öldü — takip durdu");
          }
          const ent = bot.players[playerName]?.entity;
          if (!ent) break;

          const d = bot.entity.position.distanceTo(ent.position);

          // sprint açık kalsın (pathfinder movements ara sıra yenile)
          if (Math.random() < 0.05) {
            ensureMovement(instance, { allowSprintNow: canSprint() });
          }

          // GoalFollow entity referansı — ara sıra yenile (jitter mesafe)
          if (Math.random() < 0.08) {
            try {
              followBot.pathfinder.setGoal(new goals.GoalFollow(ent, distJitter()), true);
            } catch {
              /* */
            }
          }

          // HER zaman takip edilen kişiye bak (kullanıcı isteği)
          try {
            await stepLookAtEntity(bot, ent, turnSpeed(instance));
          } catch {
            /* */
          }

          report({
            done: 0,
            total: 0,
            label: `takip ${playerName} · ${d.toFixed(1)}m${canSprint() ? " · sprint" : ""}`
          });

          // 90–140ms — 50ms altı paket spam / AC
          await sleep(90 + Math.floor(Math.random() * 50));
        }

        clearGoal(followBot);
      } else {
        report({ done: 0, total: 0, label: `${playerName} görünmüyor — bekleniyor` });
        // beklerken de son bilinen yöne bakma yok; idle
        await sleep(1200 + Math.floor(Math.random() * 400));
      }
      if (instance.status !== "online") throw new Error("Bağlantı koptu — takip sonlandı.");
    }
  } finally {
    // iptal / ölüm / hata — pathfinder her durumda serbest
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
  const bot = instance.bot as unknown as { pathfinder?: { setGoal(g: null): void }; clearControlStates?: () => void } | null;
  try {
    bot?.pathfinder?.setGoal(null);
  } catch {
    /* noop */
  }
  try {
    // takılı sprint/jump bırakma
    const b = instance.bot;
    if (b) {
      b.setControlState("forward", false);
      b.setControlState("back", false);
      b.setControlState("left", false);
      b.setControlState("right", false);
      b.setControlState("jump", false);
      b.setControlState("sprint", false);
    }
  } catch {
    /* */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { stepLookAtEntity, easeLookAt, stepLookAt } from "./look";

import type { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken, ProgressFn } from "../../core/TaskQueue";

const GOTO_TIMEOUT_MS = 180_000;

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot çevrimdışı — hareket görevi çalıştırılamaz.");
  return bot;
}

/** pathfinder eklentisini yükle + Movements'ı bot config'inden kur (her görevde tazelenir) */
export function ensureMovement(instance: BotInstance): Bot {
  const bot = requireBot(instance);
  const anyBot = bot as unknown as { pathfinder?: { setMovements(m: unknown): void } };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);

  const cfg = instance.config.movement;
  const movements = new Movements(bot);
  movements.canDig = cfg.canDig;
  movements.allowSprinting = cfg.allowSprint;
  movements.allowParkour = cfg.allowParkour;
  movements.allow1by1towers = true;

  // feda edilebilir bloklar (engel aşarken koyabileceği) — TODO.md Faz 4
  const registry = (bot as unknown as { registry: { itemsByName: Record<string, { id: number } | undefined> } }).registry;
  const ids = cfg.scaffoldBlocks
    .map((name) => registry?.itemsByName?.[name]?.id)
    .filter((id): id is number => typeof id === "number");
  if (ids.length > 0) movements.scafoldingBlocks = ids;

  bot.pathfinder.setMovements(movements);
  return bot;
}

function pathfinderGoal(instance: BotInstance, goal: goals.Goal, token: TaskToken, timeoutMs = GOTO_TIMEOUT_MS): Promise<void> {
  const bot = ensureMovement(instance);
  bot.pathfinder.setGoal(goal);

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
    const watch = setInterval(() => {
      if (token.cancelled) {
        cleanup();
        stopGoal();
        reject(new Error(token.reason ?? "Görev iptal edildi."));
      } else if (instance.status !== "online") {
        cleanup();
        reject(new Error("Bağlantı koptu — hareket görevi sonlandı."));
      }
    }, 200);
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
  await pathfinderGoal(instance, new goals.GoalNear(x, y, z, Math.max(1, range)), token);
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
    // oyuncu tab listesinde olabilir ama menzil dışında — konumunu bilemeyiz (TODO §12)
    const inTab = Boolean(bot.players[playerName]);
    throw new Error(
      inTab
        ? `${playerName} sunucuda ama görüş menzili dışında — konumu bilinmiyor. Yakınına bir waypoint verip oradan dene.`
        : `${playerName} sunucuda görünmüyor.`
    );
  }
  report({ done: 0, total: 1, label: `${playerName} oyuncusuna gidiliyor` });
  const p = entity.position;
  await pathfinderGoal(instance, new goals.GoalNear(p.x, p.y, p.z, Math.max(1, range)), token);
  report({ done: 1, total: 1, label: `${playerName} yanına ulaşıldı` });
}

export async function runFollow(
  instance: BotInstance,
  playerName: string,
  distance: number,
  token: TaskToken,
  report: ProgressFn
): Promise<void> {
  // sürekli görev: iptal edilene dek oyuncuyu takip eder; oyuncu kaybolursa bekler
  while (!token.cancelled) {
    const bot = requireBot(instance);
    const entity = bot.players[playerName]?.entity;
    if (entity) {
      report({ done: 0, total: 0, label: `${playerName} takip ediliyor (${distance} blok)` });
      const followBot = ensureMovement(instance);
      followBot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true);
      while (!token.cancelled && instance.status === "online" && bot.players[playerName]?.entity) {
        await sleep(500);
      }
      try {
        followBot.pathfinder.setGoal(null);
      } catch {
        /* noop */
      }
    } else {
      report({ done: 0, total: 0, label: `${playerName} görünmüyor — bekleniyor` });
      await sleep(1500);
    }
    if (instance.status !== "online") throw new Error("Bağlantı koptu — takip sonlandı.");
  }
}

export function stopMovement(instance: BotInstance) {
  instance.tasks.cancelAll("kullanıcı durdurdu");
  const bot = instance.bot as unknown as { pathfinder?: { setGoal(g: null): void } } | null;
  try {
    bot?.pathfinder?.setGoal(null);
  } catch {
    /* noop */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

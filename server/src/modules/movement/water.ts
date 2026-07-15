import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

/**
 * Su hareket asisti.
 *
 * Pathfinder rota/yaw sahibidir. Bu yardımcı yalnızca su fiziğinde eksik kalan
 * dikey yüzme kontrolünü tamamlar ve su içindeyken sprint yüzünden oluşan
 * kararsızlığı engeller. Yön, sağ/sol ve normal ileri hareket kontrollerine
 * dokunmaz.
 */

const installedBots = new WeakSet<Bot>();
const EXIT_GRACE_MS = 320;
const STUCK_RISE_MS = 650;
const MIN_PROGRESS = 0.12;

type GoalLike = {
  x?: number;
  y?: number;
  z?: number;
  entity?: { position?: Vec3 };
};

type PathfinderLike = {
  goal?: GoalLike | null;
  isMoving?(): boolean;
};

function blockAt(bot: Bot, x: number, y: number, z: number) {
  try {
    return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  } catch {
    return null;
  }
}

function isWaterName(name: string): boolean {
  return (
    name === "water" ||
    name === "bubble_column" ||
    name === "seagrass" ||
    name === "tall_seagrass" ||
    name === "kelp" ||
    name === "kelp_plant"
  );
}

function waterBlockAt(bot: Bot, x: number, y: number, z: number) {
  const block = blockAt(bot, x, y, z);
  return block && isWaterName(block.name) ? block : null;
}

function isInWater(bot: Bot): boolean {
  const entityFlag = Boolean((bot.entity as unknown as { isInWater?: boolean } | undefined)?.isInWater);
  if (entityFlag) return true;
  const p = bot.entity?.position;
  if (!p) return false;
  return Boolean(
    waterBlockAt(bot, p.x, p.y + 0.05, p.z) ||
      waterBlockAt(bot, p.x, p.y + 0.85, p.z) ||
      waterBlockAt(bot, p.x, p.y + 1.5, p.z)
  );
}

function goalTarget(bot: Bot): Vec3 | null {
  try {
    const pf = bot.pathfinder as unknown as PathfinderLike;
    const goal = pf.goal;
    const entityPos = goal?.entity?.position;
    if (entityPos) return entityPos;
    if (
      goal &&
      typeof goal.x === "number" &&
      typeof goal.y === "number" &&
      typeof goal.z === "number" &&
      Number.isFinite(goal.x) &&
      Number.isFinite(goal.y) &&
      Number.isFinite(goal.z)
    ) {
      return new Vec3(Number(goal.x), Number(goal.y), Number(goal.z));
    }
  } catch {
    /* pathfinder henüz hazır olmayabilir */
  }
  return null;
}

function pathfinderActive(bot: Bot): boolean {
  try {
    const pf = bot.pathfinder as unknown as PathfinderLike;
    if (!pf.goal) return false;
    return pf.isMoving?.() ?? true;
  } catch {
    return false;
  }
}

function isFlowingWater(bot: Bot): boolean {
  const p = bot.entity?.position;
  if (!p) return false;
  const block = waterBlockAt(bot, p.x, p.y + 0.1, p.z) ?? waterBlockAt(bot, p.x, p.y + 0.9, p.z);
  if (!block || block.name !== "water") return block?.name === "bubble_column";
  const metadata = Number((block as unknown as { metadata?: number }).metadata ?? 0);
  return Number.isFinite(metadata) && metadata !== 0;
}

function needsBankClimb(bot: Bot): boolean {
  const p = bot.entity?.position;
  if (!p) return false;

  // Pathfinder yaw'ı belirler; yalnızca o yönün önündeki kıyı basamağını test ederiz.
  const dx = -Math.sin(bot.entity.yaw);
  const dz = -Math.cos(bot.entity.yaw);
  const x = p.x + dx * 0.68;
  const z = p.z + dz * 0.68;
  const y = Math.floor(p.y);
  const front = blockAt(bot, x, y, z);
  const above = blockAt(bot, x, y + 1, z);
  const above2 = blockAt(bot, x, y + 2, z);

  const frontSolid = Boolean(front && !isWaterName(front.name) && front.boundingBox !== "empty");
  const clear = (b: ReturnType<typeof blockAt>) => !b || b.boundingBox === "empty" || isWaterName(b.name);
  return frontSolid && clear(above) && clear(above2);
}

/** Bot başına yalnızca bir kez kurulur. */
export function installWaterMovementAssist(bot: Bot): void {
  if (installedBots.has(bot)) return;
  installedBots.add(bot);

  let lastPos: Vec3 | null = null;
  let lastProgressAt = Date.now();
  let forcedJump = false;
  let wasInWater = false;
  let exitGraceUntil = 0;

  const releaseJump = () => {
    if (!forcedJump) return;
    forcedJump = false;
    try {
      bot.setControlState("jump", false);
    } catch {
      /* bağlantı kapanmış olabilir */
    }
  };

  const onPhysicsTick = () => {
    const entity = bot.entity;
    if (!entity) return;

    const now = Date.now();
    const active = pathfinderActive(bot);
    const inWater = isInWater(bot);

    if (lastPos && entity.position.distanceTo(lastPos) >= MIN_PROGRESS) {
      lastPos = entity.position.clone();
      lastProgressAt = now;
    } else if (!lastPos) {
      lastPos = entity.position.clone();
      lastProgressAt = now;
    }

    if (inWater) {
      wasInWater = true;
      exitGraceUntil = now + EXIT_GRACE_MS;
    }

    if (!active) {
      releaseJump();
      wasInWater = inWater;
      lastPos = entity.position.clone();
      lastProgressAt = now;
      return;
    }

    if (!inWater && now > exitGraceUntil) {
      if (wasInWater) releaseJump();
      wasInWater = false;
      return;
    }

    // Su içinde sprint, yüzeyde titreme ve blok kenarında takılmayı artırır.
    try {
      bot.setControlState("sprint", false);
    } catch {
      /* */
    }

    const target = goalTarget(bot);
    const dy = target ? target.y - entity.position.y : 0;
    const targetBelow = Boolean(target && dy < -1.15);
    const headInWater = Boolean(waterBlockAt(bot, entity.position.x, entity.position.y + 1.5, entity.position.z));
    const surface = inWater && !headInWater;
    const flowing = inWater && isFlowingWater(bot);
    const bankClimb = inWater && needsBankClimb(bot);
    const stalled = now - lastProgressAt >= STUCK_RISE_MS;

    // Hedef açıkça aşağıdaysa dalışı bozma. Diğer durumlarda sürekli jump,
    // akıntıda yükselmeyi ve kıyı basamağına çıkışı kararlı hale getirir.
    const shouldRise =
      now <= exitGraceUntil &&
      (!targetBelow || surface || bankClimb || stalled) &&
      (headInWater || surface || flowing || bankClimb || dy > 0.25 || stalled);

    if (shouldRise) {
      forcedJump = true;
      try {
        bot.setControlState("jump", true);
      } catch {
        /* */
      }
    }
  };

  const cleanup = () => {
    releaseJump();
    try {
      bot.removeListener("physicsTick", onPhysicsTick);
      bot.removeListener("end", cleanup);
      bot.removeListener("kicked", cleanup);
    } catch {
      /* */
    }
  };

  bot.on("physicsTick", onPhysicsTick);
  bot.once("end", cleanup);
  bot.once("kicked", cleanup);
}

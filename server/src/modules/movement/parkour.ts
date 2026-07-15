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
  /** sprint zorunlu (3–4 blok için) */
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
  if (!bot || instance.status !== "online") throw new Error("Bot çevrimdışı");
  const anyBot = bot as unknown as { pathfinder?: { setMovements(m: unknown): void; setGoal(g: unknown): void } };
  if (!anyBot.pathfinder) bot.loadPlugin(pathfinder);
  const cfg = instance.config.movement;
  const movements = new Movements(bot);
  movements.canDig = Boolean(cfg.canDig);
  movements.allowSprinting = cfg.parkourSprint !== false && cfg.allowSprint !== false;
  movements.allowParkour = cfg.allowParkour !== false;
  movements.allow1by1towers = Boolean(cfg.allowTower);
  try {
    (movements as { maxDrop?: number }).maxDrop = Math.max(cfg.maxDrop ?? 3, Math.min(8, (cfg.parkourMaxGap ?? 3) + 2));
  } catch {
    /* */
  }
  bot.pathfinder.setMovements(movements);
  return bot;
}

function clearControls(bot: Bot) {
  for (const k of ["forward", "back", "left", "right", "jump", "sprint"] as const) {
    try {
      bot.setControlState(k, false);
    } catch {
      /* */
    }
  }
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
 * Botun baktığı yönde / hedefe doğru 2–4 blok parkour inişi ara.
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
      // gap = boşluk; iniş ≈ gap+1 blok merkez mesafesi
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

  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }
  clearControls(bot);

  const lx = landing.x + 0.5;
  const ly = landing.y;
  const lz = landing.z + 0.5;

  // hedefe bak
  try {
    await bot.lookAt(v3(lx, ly + 0.5, lz), true);
  } catch {
    /* */
  }

  // kenara hizalan — acele etme (daha emin iniş)
  const edgeMs = g >= 4 ? 320 : g === 3 ? 220 : 150;
  bot.setControlState("forward", true);
  if (g >= 3) bot.setControlState("sprint", true);
  await sleep(edgeMs);

  // zıpla — kısa basış, sonra bırak
  if (g >= 4) await sleep(60);
  bot.setControlState("jump", true);
  await sleep(g >= 4 ? 80 : g === 3 ? 70 : 60);
  bot.setControlState("jump", false);

  // havada yön tut (daha kontrollü süre)
  bot.setControlState("forward", true);
  if (g >= 3) bot.setControlState("sprint", true);
  const airMs = g === 2 ? 360 : g === 3 ? 460 : 560;
  const t0 = Date.now();
  let fellPast = false;
  while (Date.now() - t0 < airMs && !token.cancelled) {
    const pos = bot.entity.position;
    const vy = bot.entity.velocity?.y ?? 0;
    // inişi kaçırdı / tehlikeli düşüş — lookAt durdur, MLG'ye bırak
    if (pos.y < ly - 1.4 && vy < -0.35) {
      fellPast = true;
      clearControls(bot);
      break;
    }
    // FallGuard MLG başladıysa parkur bakışını bırak
    const fg = instance.survival?.getFallGuardState?.();
    if (fg?.active || (fg?.falling && (fg.predictedDamage ?? 0) >= 2)) {
      fellPast = true;
      clearControls(bot);
      break;
    }
    try {
      await bot.lookAt(v3(lx, ly + 0.8, lz), true);
    } catch {
      /* */
    }
    // inişe yaklaştıysa bırak
    const d = pos.distanceTo(v3(lx, ly, lz) as never);
    if (d < 1.2 && bot.entity.onGround) break;
    await sleep(40);
  }

  clearControls(bot);
  if (fellPast) {
    instance.getLogger().info("Parkur atlama", "iniş kaçtı — MLG'ye bırakıldı");
    await yieldFallToMlg(instance, bot, token);
    return false;
  }
  await sleep(80);

  if (token.cancelled) throw new Error(token.reason ?? "iptal");

  // başarı: iniş bloğuna yakın ve yerde
  const pos = bot.entity.position;
  const landed =
    bot.entity.onGround &&
    Math.hypot(pos.x - lx, pos.z - lz) < 1.6 &&
    Math.abs(pos.y - ly) < 1.8;

  if (landed) {
    report?.({ done: 1, total: 1, label: `parkur ${g} OK` });
    instance.getLogger().info(`Parkur atlama başarılı`, `${g} blok → ${landing.x},${landing.y},${landing.z}`);
  } else {
    instance.getLogger().debug("Parkur atlama zayıf iniş", `gap=${g} d=${Math.hypot(pos.x - lx, pos.z - lz).toFixed(1)}`);
  }
  return landed;
}

type LadderPos = { x: number; y: number; z: number };

/** Ayak hizasına yakın merdiven — yukarıdaki düşülen merdivene bakmasın */
function findNearbyLadder(bot: Bot, fx: number, fy: number, fz: number): LadderPos | null {
  // önce aynı seviye, sonra ±1, en fazla ±2 (yukarı 3+ = düşme sonrası yanlış hedef)
  for (const dy of [0, 1, -1, 2, -2]) {
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

/** Gerçekten merdiven collider'ında mı (uzak merdiven sayılmaz) */
function stillOnLadder(bot: Bot): boolean {
  if (!bot.entity) return false;
  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);
  // sadece ayak / gövde hücresi — ±1 arama yok (düşüşte "hâlâ merdivende" sanmasın)
  return (
    isLadder(bot, fx, fy, fz) ||
    isLadder(bot, fx, fy + 1, fz) ||
    isLadder(bot, fx, Math.floor(fy - 0.2), fz)
  );
}

/** Merdiven duvar yönü (facing) — yapışmak için duvara bak */
function ladderFacingOffset(bot: Bot, lx: number, ly: number, lz: number): { x: number; z: number } {
  const b = bot.blockAt(v3(lx, ly, lz));
  try {
    const props = (b as { getProperties?: () => Record<string, unknown> })?.getProperties?.();
    const face = String(props?.facing ?? "").toLowerCase();
    if (face === "north") return { x: 0, z: 0.35 };
    if (face === "south") return { x: 0, z: -0.35 };
    if (face === "west") return { x: 0.35, z: 0 };
    if (face === "east") return { x: -0.35, z: 0 };
  } catch {
    /* */
  }
  return { x: 0, z: 0 };
}

/** Yatay olarak merdivene yakın mı */
function nearLadderHoriz(bot: Bot, ladder: LadderPos, max = 1.35): boolean {
  const p = bot.entity?.position;
  if (!p) return false;
  return Math.hypot(p.x - (ladder.x + 0.5), p.z - (ladder.z + 0.5)) <= max;
}

/**
 * Düşüş sırasında parkur/merdiven kontrolü bırakır; MLG (FallGuard) bakış/kovayı kullanabilsin.
 * lookAt YOK — düşülen yere kilitlenmesin.
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
      // MLG aktif — bakış/kontrol çalma
      await sleep(40);
      continue;
    }

    if (bot.entity.onGround && Math.abs(vy) < 0.12) {
      // MLG yeni bittiyse su/yerleşim için kısa bekle
      if (sawMlg) await sleep(120);
      break;
    }
    // hâlâ havada ama FallGuard henüz busy değil — ona zaman ver (lookAt yok)
    await sleep(40);
  }
  clearControls(bot);
  await sleep(80);
}

/** Merdiven XZ merkezine yavaş yanaş — zıplama yok; uzak/yüksek merdivene kilitlenme yok */
async function attachToLadder(bot: Bot, ladder: LadderPos): Promise<boolean> {
  if (!bot.entity) return false;
  // merdiven botun çok üstünde/altında veya uzaktaysa yapışma (stuck look)
  if (Math.abs(ladder.y - bot.entity.position.y) > 2.5) return false;
  if (!nearLadderHoriz(bot, ladder, 1.6)) return false;

  const face = ladderFacingOffset(bot, ladder.x, ladder.y, ladder.z);
  const cx = ladder.x + 0.5 + face.x * 0.4;
  const cz = ladder.z + 0.5 + face.z * 0.4;
  // bakış: bot göz hizası — düşülen yukarı bloğa bakma
  const lookY = bot.entity.position.y + 0.4;
  try {
    await bot.lookAt(v3(ladder.x + 0.5, lookY, ladder.z + 0.5), true);
  } catch {
    /* */
  }
  bot.setControlState("sprint", false);
  bot.setControlState("jump", false);
  bot.setControlState("forward", true);
  await sleep(200);
  const p = bot.entity?.position;
  if (p && Math.hypot(p.x - cx, p.z - cz) < 0.55) {
    bot.setControlState("forward", false);
  } else {
    await sleep(140);
    bot.setControlState("forward", false);
  }
  await sleep(160);
  return stillOnLadder(bot) || nearLadderHoriz(bot, ladder, 0.9);
}

/**
 * Merdiven/vine tırman — emin adımlar.
 * Düşerse: kontrolleri bırak → yere in → lookAt döngüsü YOK → false dön (pathfinder devam etsin).
 * Başarı: sadece targetY'ye ulaşıldıysa (yerde olmak yetmez).
 */
export async function climbLadderParkour(
  instance: BotInstance,
  targetY: number,
  token: TaskToken,
  report?: ProgressFn
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity) return false;
  ensureParkourBot(instance);

  report?.({ done: 0, total: 1, label: `merdiven (emin) → y=${Math.floor(targetY)}` });
  clearControls(bot);
  try {
    bot.setControlState("sprint", false);
  } catch {
    /* */
  }

  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }

  const startY = bot.entity.position.y;
  let peakY = startY;
  const t0 = Date.now();
  let stuckTicks = 0;
  let reattachFails = 0;
  let lastY = startY;
  let climbPulses = 0;
  let fell = false;

  // --- 1) merdivene yavaş yapış ---
  {
    const p = bot.entity.position;
    const ladder = findNearbyLadder(bot, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    if (ladder) {
      await attachToLadder(bot, ladder);
    } else {
      bot.setControlState("forward", true);
      await sleep(200);
      bot.setControlState("forward", false);
      await sleep(120);
    }
  }

  // --- 2) tırmanma ---
  while (!token.cancelled && Date.now() - t0 < 45_000) {
    const p = bot.entity.position;
    if (p.y > peakY) peakY = p.y;
    if (p.y >= targetY - 0.4) break;

    const vy = bot.entity.velocity?.y ?? 0;
    const dropFromPeak = peakY - p.y;

    // --- DÜŞME: hızlı iniş veya peak'ten kayıp — MLG'ye bırak, stuck look yok ---
    const fallingHard = vy < -0.28 && !stillOnLadder(bot);
    const slippedDown = dropFromPeak >= 1.2 && !stillOnLadder(bot) && vy < -0.05;
    // merdiven hücresinde olsa bile hızla aşağı + yükseklik kaybı = koptu
    const freeFallOnClimbable = dropFromPeak >= 1.5 && vy < -0.4;

    if (fallingHard || slippedDown || freeFallOnClimbable) {
      clearControls(bot);
      fell = true;
      instance.getLogger().info(
        "Merdiven düştü",
        `peak=${peakY.toFixed(1)} y=${p.y.toFixed(1)} vy=${vy.toFixed(2)} — MLG'ye bırakıldı`
      );
      report?.({ done: 0, total: 1, label: "merdiven düştü — MLG…" });
      await yieldFallToMlg(instance, bot, token);
      break;
    }

    // yere indiyse ve peak'e göre kaybettiyse — tekrar yapışma stuck'ı yok
    if (bot.entity.onGround && peakY - p.y >= 1.0 && !stillOnLadder(bot)) {
      fell = true;
      clearControls(bot);
      instance.getLogger().info("Merdiven düştü", `yerde peak=${peakY.toFixed(1)} y=${p.y.toFixed(1)}`);
      break;
    }

    const fx = Math.floor(p.x);
    const fy = Math.floor(p.y);
    const fz = Math.floor(p.z);
    const ladder = findNearbyLadder(bot, fx, fy, fz);

    if (!ladder || !nearLadderHoriz(bot, ladder, 1.5)) {
      clearControls(bot);
      stuckTicks++;
      // yere indiysek ve merdiven yok/uzak — çık (lookAt spam yok)
      if (bot.entity.onGround && stuckTicks >= 3) {
        reattachFails++;
        if (reattachFails >= 2 || peakY - p.y >= 0.8) {
          fell = peakY - p.y >= 0.8;
          break;
        }
      }
      if (stuckTicks > 8) break;
      await sleep(200);
      // sadece ayak hizasında yakın merdiven varsa bir kez dene
      const re = findNearbyLadder(
        bot,
        Math.floor(bot.entity.position.x),
        Math.floor(bot.entity.position.y),
        Math.floor(bot.entity.position.z)
      );
      if (re && nearLadderHoriz(bot, re, 1.4) && Math.abs(re.y - bot.entity.position.y) <= 2) {
        const ok = await attachToLadder(bot, re);
        if (!ok) reattachFails++;
      } else {
        reattachFails++;
      }
      if (reattachFails >= 4) break;
      continue;
    }

    stuckTicks = 0;

    // bakış: göz hizası merdiven (yukarı / düşme noktası değil)
    try {
      const lookY = bot.entity.position.y + 0.35;
      await bot.lookAt(v3(ladder.x + 0.5, lookY, ladder.z + 0.5), true);
    } catch {
      /* */
    }

    bot.setControlState("sprint", false);
    bot.setControlState("forward", true);
    await sleep(90);

    bot.setControlState("jump", true);
    await sleep(65);
    bot.setControlState("jump", false);
    await sleep(260);
    climbPulses++;

    if (climbPulses % 2 === 0) {
      bot.setControlState("forward", false);
      await sleep(180);
    }

    // koptu mu?
    if (!stillOnLadder(bot)) {
      clearControls(bot);
      await sleep(150);
      // düşüş hızı varsa land bekle
      const v2 = bot.entity.velocity?.y ?? 0;
      if (v2 < -0.2) {
        fell = true;
        await yieldFallToMlg(instance, bot, token);
        break;
      }
      if (bot.entity.onGround && peakY - bot.entity.position.y >= 1.0) {
        fell = true;
        break;
      }
      // tek nazik reattach
      if (bot.entity.onGround && reattachFails < 3) {
        const re = findNearbyLadder(
          bot,
          Math.floor(bot.entity.position.x),
          Math.floor(bot.entity.position.y),
          Math.floor(bot.entity.position.z)
        );
        if (re && nearLadderHoriz(bot, re, 1.4)) {
          const ok = await attachToLadder(bot, re);
          if (!ok) reattachFails++;
        } else {
          reattachFails++;
        }
      }
    }

    const ny = bot.entity.position.y;
    if (Math.abs(ny - lastY) < 0.08) {
      stuckTicks++;
      clearControls(bot);
      await sleep(200);
      if (stuckTicks > 12) break;
    } else {
      stuckTicks = 0;
      lastY = ny;
      reattachFails = 0;
    }

    report?.({
      done: 0,
      total: 1,
      label: `merdiven emin y=${bot.entity.position.y.toFixed(1)} → ${targetY.toFixed(0)}`
    });
  }

  clearControls(bot);

  // düştüyse: çıkış hop'u yok, lookAt yok — pathfinder devralsın
  if (fell || token.cancelled) {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: "merdiven düştü — path devam" });
    instance.getLogger().info(
      "Merdiven parkuru iptal",
      `düşüş sonrası y=${bot.entity?.position.y.toFixed(1) ?? "?"} (stuck look yok)`
    );
    return false;
  }

  // hedef yüksekliğe ulaşmadıysa çıkış deneme (yanlış "başarı" yok)
  if (bot.entity.position.y < targetY - 1.0) {
    clearControls(bot);
    report?.({ done: 1, total: 1, label: "merdiven yarıda kaldı" });
    instance.getLogger().info(
      "Merdiven parkuru kısmi",
      `y=${bot.entity.position.y.toFixed(1)} hedef=${targetY.toFixed(1)}`
    );
    return false;
  }

  await sleep(280); // tepede otur

  // --- 3) güvenli çıkış ---
  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);

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
    let edgeRisk = 0;
    for (const [ex, ez] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ] as const) {
      if (!isSolid(bot, fx + dx + ex, fy - 1, fz + dz + ez) && !isSolid(bot, fx + dx + ex, fy - 2, fz + dz + ez)) {
        edgeRisk += 0.5;
      }
    }
    lands.push({ dx, dz, score: Math.abs(dx) + Math.abs(dz) + edgeRisk });
  }
  lands.sort((a, b) => a.score - b.score);

  if (lands.length > 0) {
    const { dx, dz } = lands[0]!;
    try {
      await bot.lookAt(v3(fx + dx + 0.5, fy, fz + dz + 0.5), true);
    } catch {
      /* */
    }
    await sleep(150);
    bot.setControlState("sprint", false);
    bot.setControlState("forward", true);
    await sleep(180);
    const needHop = stillOnLadder(bot) && !bot.entity.onGround;
    if (needHop) {
      bot.setControlState("jump", true);
      await sleep(50);
      bot.setControlState("jump", false);
    }
    await sleep(220);
    bot.setControlState("forward", false);
    await sleep(150);
  } else {
    instance.getLogger().info("Merdiven parkuru", "güvenli çıkış yok — tepede bırakıldı");
    await sleep(250);
  }

  clearControls(bot);
  await sleep(80);

  const ok = bot.entity.position.y >= targetY - 1.0;
  report?.({ done: 1, total: 1, label: ok ? "merdiven OK (emin)" : "merdiven kısmi" });
  if (ok) {
    instance.getLogger().info("Merdiven parkuru tamam", `y=${bot.entity.position.y.toFixed(1)}`);
  }
  return ok;
}

/**
 * Parkour destekli goto: pathfinder parkour + noPath'te gap jump + merdiven.
 */
export async function runParkourGoto(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  range: number,
  token: TaskToken,
  report: ProgressFn
): Promise<void> {
  const bot = instance.bot;
  if (!bot?.entity) throw new Error("Bot çevrimdışı");
  const cfg = parkourFromMovement(instance.config.movement);

  ensureParkourBot(instance);
  report({ done: 0, total: 1, label: `parkur git → ${x},${y},${z}` });

  const goal = new goals.GoalNear(x, y, z, Math.max(1, range));
  let attempts = 0;
  const maxAttempts = 8;
  /** Düşüş/fail sonrası aynı merdivene hemen kilitlenmesin (stuck look) */
  let ladderCooldownUntil = 0;

  while (!token.cancelled && attempts < maxAttempts) {
    attempts++;
    const dist = bot.entity.position.distanceTo(v3(x, y, z) as never);
    if (dist <= range + 0.8) {
      report({ done: 1, total: 1, label: "parkur hedefe ulaşıldı" });
      return;
    }

    // merdiven: hedef yukarıdaysa; düşüş cooldown yoksa dene
    const yNow = bot.entity.position.y;
    if (cfg.ladderParkour && y > yNow + 2 && Date.now() >= ladderCooldownUntil) {
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
        const climbed = await climbLadderParkour(
          instance,
          Math.min(y, beforeY + 6),
          token,
          report
        );
        if (!climbed) {
          // düştü veya yarıda — pathfinder'a bırak; kısa süre merdiven retry yok
          ladderCooldownUntil = Date.now() + 3500;
          instance.getLogger().info("Parkur", "merdiven fail — 3.5s pathfinder (stuck look yok)");
          clearControls(bot);
          await sleep(200);
        } else if (bot.entity.position.y > beforeY + 0.8) {
          continue;
        }
      }
    }

    try {
      await runPathOnce(instance, goal, token, 45_000);
      if (bot.entity.position.distanceTo(v3(x, y, z) as never) <= range + 1) {
        report({ done: 1, total: 1, label: "parkur hedefe ulaşıldı" });
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // noPath → gap jump dene
      if (!cfg.enabled || (!msg.includes("noPath") && !msg.includes("yol"))) {
        if (attempts >= maxAttempts) throw e;
      }

      if (cfg.enabled) {
        const land = findGapLanding(bot, { x, y, z }, cfg.maxGap);
        if (land && land.gap <= cfg.maxGap) {
          instance.getLogger().info("Parkur gap jump", `${land.gap} blok → ${land.x},${land.y},${land.z}`);
          const ok = await executeGapJump(instance, land, land.gap, token, report);
          if (ok) continue;
        }
      }

      // son çare: biraz bekle ve path tekrarla
      await sleep(300);
      if (attempts >= maxAttempts) throw e instanceof Error ? e : new Error(msg);
    }
  }

  if (token.cancelled) throw new Error(token.reason ?? "iptal");
  if (bot.entity.position.distanceTo(v3(x, y, z) as never) > range + 1.5) {
    throw new Error("Parkur ile hedefe ulaşılamadı");
  }
  report({ done: 1, total: 1, label: "parkur hedefe ulaşıldı" });
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
        reject(new Error(token.reason ?? "iptal"));
      }
    }, 200);
    const deadline = setTimeout(() => {
      cleanup();
      stop();
      reject(new Error("parkur path zaman aşımı"));
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

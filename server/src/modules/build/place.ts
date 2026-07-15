import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";
import { goals } from "mineflayer-pathfinder";
import type { BotInstance } from "../../core/BotInstance";
import type { TaskToken } from "../../core/TaskQueue";
import { ensureMovement } from "../movement";
import { equipBestToolForBlock, pickScaffoldItem, type ScaffoldTracker } from "./scaffold";
import { v3 } from "./vec3util";

const FACES: [number, number, number][] = [
  [0, -1, 0],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1]
];

/** Yerleştirme menzili — bu içinde pathfinder ÇAĞIRMA */
export const PLACE_REACH = 4.5;
/** Path hedefe yaklaşma yarıçapı */
const PATH_RANGE = 2.8;
/** Path zaman aşımı (ms) */
const PATH_TIMEOUT_MS = 8_000;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * soft=true: pathfinder/hedefi BOZMA (yürürken menzilde koy).
 * soft=false: dur, kontrol temizle, bak-koy için sabitle.
 */
async function settleForPlacement(bot: Bot, soft = false) {
  if (!soft) {
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* */
    }
    try {
      bot.clearControlStates();
    } catch {
      /* */
    }
    try {
      bot.setControlState("jump", false);
    } catch {
      /* */
    }
  }
  const v = bot.entity?.velocity;
  const moving =
    Boolean(v) &&
    (Math.abs(v!.x) > 0.04 || Math.abs(v!.z) > 0.04 || Math.abs(v!.y) > 0.12);
  if (soft) {
    // yürürken sadece kısa nefes; path bozulmasın
    await sleep(moving ? 25 : 10);
    return;
  }
  await sleep(moving ? 140 : 50);
}

function dist3(bot: Bot, x: number, y: number, z: number): number {
  const p = bot.entity.position;
  const dx = p.x - x;
  const dy = p.y - y;
  const dz = p.z - z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Sadece gerekirse pathfinder. Zaten yakındaysa no-op.
 * clearGoal=false: hedefi bırakma — yürürken yerleştirme için.
 * onTick: yürürken menzildeki blokları koymak için.
 */
export async function pathNear(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  range: number,
  token: TaskToken,
  opts?: { clearGoal?: boolean; timeoutMs?: number; onTick?: () => void | Promise<void> }
) {
  const bot = ensureMovement(instance);
  if (dist3(bot, x, y, z) <= range + 0.5) return;

  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
  const t0 = Date.now();
  const timeout = opts?.timeoutMs ?? PATH_TIMEOUT_MS;
  let noPath = false;
  let lastBest = dist3(bot, x, y, z);
  let lastProgressAt = Date.now();
  const onPath = (r: { status?: string }) => {
    if (r?.status === "noPath" || r?.status === "timeout") noPath = true;
  };
  bot.on("path_update", onPath);
  try {
    while (!token.cancelled && Date.now() - t0 < timeout) {
      if (noPath) break;
      const d = dist3(bot, x, y, z);
      if (d <= range + 0.55) break;
      // ilerleme varsa sabret; takılıysa çık (uzakken "zorla" bekleme)
      if (d < lastBest - 0.25) {
        lastBest = d;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > 7_000) {
        break;
      }
      if (opts?.onTick) {
        try {
          await opts.onTick();
        } catch {
          /* cluster place hatası path'i bozmasın */
        }
      }
      await sleep(50);
    }
  } finally {
    bot.removeListener("path_update", onPath);
    if (opts?.clearGoal !== false) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
    }
  }
  if (token.cancelled) throw new Error(token.reason ?? "iptal");
}

export function distToBlock(instance: BotInstance, x: number, y: number, z: number): number {
  const bot = instance.bot;
  if (!bot?.entity) return 999;
  return dist3(bot, x + 0.5, y + 0.5, z + 0.5);
}

/** Şema blok adı → envanter item adı (sıvı / özel) */
export function itemNameForBlock(blockName: string): string[] {
  const n = blockName.replace(/^minecraft:/, "");
  if (n === "water" || n === "flowing_water") return ["water_bucket"];
  if (n === "lava" || n === "flowing_lava") return ["lava_bucket"];
  if (n === "powder_snow") return ["powder_snow_bucket"];
  if (n === "redstone_wire") return ["redstone"];
  if (n === "tripwire") return ["string"];
  if (n.endsWith("_wall_sign") || n.endsWith("_sign")) {
    const base = n.replace(/_wall_sign$/, "_sign").replace(/_hanging_sign$/, "_sign");
    return [base, n];
  }
  return [n];
}

/**
 * Mutlak (x,y,z) konumuna named block yerleştir.
 * opts.skipPath: yürürken yerleştir — path açma, menzil dışındaysa "outofreach"
 */
export async function placeBlockAt(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  blockName: string,
  token: TaskToken,
  scaffolds: ScaffoldTracker,
  opts?: { retries?: number; skipPath?: boolean; softSettle?: boolean }
): Promise<"placed" | "skipped" | "failed" | "outofreach"> {
  const retries = Math.max(1, opts?.retries ?? 1);
  let last: "placed" | "skipped" | "failed" | "outofreach" = "failed";
  for (let attempt = 0; attempt < retries; attempt++) {
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    last = await placeBlockAtOnce(instance, x, y, z, blockName, token, scaffolds, {
      skipPath: opts?.skipPath,
      softSettle: opts?.softSettle
    });
    if (last === "placed" || last === "skipped") return last;
    if (last === "outofreach") return last;
    if (attempt + 1 < retries) await sleep(50 + attempt * 40);
  }
  return last;
}

async function placeBlockAtOnce(
  instance: BotInstance,
  x: number,
  y: number,
  z: number,
  blockName: string,
  token: TaskToken,
  scaffolds: ScaffoldTracker,
  opts?: { skipPath?: boolean; softSettle?: boolean }
): Promise<"placed" | "skipped" | "failed" | "outofreach"> {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot çevrimdışı");
  const target = v3(Math.floor(x), Math.floor(y), Math.floor(z));
  const name = String(blockName).replace(/^minecraft:/, "");
  const tx = target.x + 0.5;
  const ty = target.y + 0.5;
  const tz = target.z + 0.5;
  const soft = Boolean(opts?.softSettle || opts?.skipPath);

  // --- 1) Menzil dışındaysa: yerinde zorlama, ÖNCE yürü ---
  let d = dist3(bot, tx, ty, tz);
  if (d > PLACE_REACH) {
    if (opts?.skipPath) return "outofreach";
    await pathNear(instance, tx, target.y, tz, PATH_RANGE, token, {
      clearGoal: true,
      timeoutMs: 12_000
    });
    d = dist3(bot, tx, ty, tz);
    // hâlâ çok uzaksa (path bitemedi) — outofreach, üst döngü yeniden yollasın
    if (d > PLACE_REACH + 1.2) return "outofreach";
  }

  // yakınken settle (soft: yürüyüşü bozma)
  await settleForPlacement(bot, soft);

  let existing = bot.blockAt(target);
  if (existing && (existing.name === name || namesMatch(existing.name, name))) return "skipped";

  // Yanlış blok → kır, sonra doğru koy
  if (existing && !isReplaceableBlock(existing.name) && !namesMatch(existing.name, name)) {
    if (opts?.skipPath && dist3(bot, tx, ty, tz) > PLACE_REACH) {
      return "outofreach";
    }
    const cleared = await clearBlockAt(instance, target, token, { skipPath: opts?.skipPath });
    if (!cleared) return opts?.skipPath ? "outofreach" : "failed";
    existing = bot.blockAt(target);
    if (existing && !isReplaceableBlock(existing.name) && !namesMatch(existing.name, name)) {
      return "failed";
    }
  }

  const itemNames = itemNameForBlock(name);
  const item = bot.inventory.items().find((i) => itemNames.includes(i.name));
  if (!item) return "failed";

  d = dist3(bot, tx, ty, tz);
  if (opts?.skipPath && d > PLACE_REACH) return "outofreach";

  // --- ayak altı / durduğu hücre: önce kenara çek; zıpla sadece kule ---
  const occ = occupancyRelation(bot, target);
  if (occ === "feet" || occ === "head") {
    if (opts?.skipPath) return "outofreach";
    const moved = await stepAside(instance, token, target);
    if (!moved) {
      if (occ === "feet") {
        const jumped = await jumpPlaceOnBelow(instance, target, item, name, scaffolds);
        if (jumped) return "placed";
      }
      return "failed";
    }
    d = dist3(bot, tx, ty, tz);
  } else if (occ === "under") {
    if (opts?.skipPath) return "outofreach";
    const moved = await stepAside(instance, token, target);
    if (moved) {
      d = dist3(bot, tx, ty, tz);
    } else {
      const jumped = await jumpPlaceOnBelow(instance, target, item, name, scaffolds);
      if (jumped) return "placed";
      return "failed";
    }
  }

  // sıvı: kova
  if (
    item.name.endsWith("_bucket") &&
    (name === "water" || name === "lava" || name === "powder_snow" || name.includes("water") || name.includes("lava"))
  ) {
    if (!opts?.skipPath && d > PLACE_REACH) {
      await pathNear(instance, tx, target.y, tz, PATH_RANGE, token, { timeoutMs: 10_000 });
    }
    try {
      await bot.lookAt(target.offset(0.5, 0.25, 0.5), false);
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      bot.activateItem(false);
      await sleep(40);
      try {
        bot.deactivateItem();
      } catch {
        /* */
      }
      const after = bot.blockAt(target);
      if (
        after &&
        (after.name.includes(name.split("_")[0]!) ||
          after.name === name ||
          after.name.includes("water") ||
          after.name.includes("lava"))
      ) {
        scaffolds.protectStructure(target.x, target.y, target.z);
        return "placed";
      }
      return "failed";
    } catch {
      return "failed";
    }
  }

  // hâlâ menzil dışı (path kısmi) → bir kez daha yaklaş
  d = dist3(bot, tx, ty, tz);
  if (!opts?.skipPath && d > PLACE_REACH) {
    await pathNear(instance, tx, target.y, tz, PATH_RANGE, token, { timeoutMs: 10_000 });
    d = dist3(bot, tx, ty, tz);
    if (d > PLACE_REACH + 0.8) return "outofreach";
    await settleForPlacement(bot);
  }

  // hâlâ üstündeyse bir kez daha kenara
  if (occupancyRelation(bot, target) === "feet" || occupancyRelation(bot, target) === "head") {
    if (opts?.skipPath) return "outofreach";
    await stepAside(instance, token, target);
  }

  let ref = findReference(bot, target);
  if (!ref) {
    if (opts?.skipPath) return "outofreach";
    await ensureSupport(instance, target, token, scaffolds);
    ref = findReference(bot, target);
  }
  if (!ref) return "failed";

  const eyeH = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
  const eyeY = bot.entity.position.y + eyeH;
  if (target.y - eyeY > 2.8) {
    if (opts?.skipPath) return "outofreach";
    await climbWithScaffold(instance, target.y - 1, token, scaffolds);
  }

  try {
    if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
  } catch {
    return "failed";
  }

  ref = findReference(bot, target) ?? ref;
  try {
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), false);
    await bot.lookAt(ref.block.position.offset(0.5, 0.5, 0.5), false);
    await bot.placeBlock(ref.block, ref.face);
    await sleep(35);
    let after = bot.blockAt(target);
    if (after && (after.name === name || after.name === item.name || namesMatch(after.name, name))) {
      scaffolds.protectStructure(target.x, target.y, target.z);
      return "placed";
    }
    await sleep(60);
    after = bot.blockAt(target);
    if (after && (after.name === name || after.name === item.name || namesMatch(after.name, name))) {
      scaffolds.protectStructure(target.x, target.y, target.z);
      return "placed";
    }
    return "failed";
  } catch {
    return "failed";
  }
}

/** Bot hedef hücreyle nasıl çakışıyor? */
function occupancyRelation(bot: Bot, target: Vec3): "none" | "under" | "feet" | "head" {
  if (!bot.entity) return "none";
  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);
  if (target.x !== fx || target.z !== fz) return "none";
  if (target.y === fy - 1) return "under";
  if (target.y === fy) return "feet";
  if (target.y === fy + 1) return "head";
  return "none";
}

/**
 * Kenara çekil — hedef hücrenin dışına (komşu sağlam zemin).
 */
async function stepAside(
  instance: BotInstance,
  token: TaskToken,
  awayFrom: Vec3
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity) return false;

  try {
    bot.pathfinder?.setGoal(null);
  } catch {
    /* */
  }

  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);

  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ];
  // hedeften uzaklaşan yönleri önce dene
  dirs.sort((a, b) => {
    const da = Math.abs(fx + a[0] - awayFrom.x) + Math.abs(fz + a[1] - awayFrom.z);
    const db = Math.abs(fx + b[0] - awayFrom.x) + Math.abs(fz + b[1] - awayFrom.z);
    return db - da;
  });

  for (const [dx, dz] of dirs) {
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    const nx = fx + dx;
    const nz = fz + dz;
    const ground = bot.blockAt(v3(nx, fy - 1, nz));
    const atFeet = bot.blockAt(v3(nx, fy, nz));
    const atHead = bot.blockAt(v3(nx, fy + 1, nz));
    if (!ground || isReplaceableBlock(ground.name)) continue;
    if (atFeet && !isReplaceableBlock(atFeet.name)) continue;
    if (atHead && !isReplaceableBlock(atHead.name)) continue;

    // kısa path
    try {
      await pathNear(instance, nx + 0.5, fy, nz + 0.5, 0.35, token, { timeoutMs: 2500, clearGoal: true });
    } catch {
      /* */
    }

    const p2 = bot.entity.position;
    if (Math.floor(p2.x) === nx && Math.floor(p2.z) === nz) return true;

    // kontrol ile it
    try {
      await bot.lookAt(v3(nx + 0.5, fy + 0.5, nz + 0.5), false);
      bot.setControlState("forward", true);
      await sleep(280);
      bot.setControlState("forward", false);
      await sleep(40);
    } catch {
      try {
        bot.setControlState("forward", false);
      } catch {
        /* */
      }
    }

    const p3 = bot.entity.position;
    if (Math.floor(p3.x) !== fx || Math.floor(p3.z) !== fz) {
      // en azından eski hücreden çıktı
      if (Math.floor(p3.x) !== awayFrom.x || Math.floor(p3.z) !== awayFrom.z || Math.floor(p3.y) !== awayFrom.y) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Ayak altı / kule: alttaki bloğun üst yüzüne zıplayarak koy.
 * target = ayak altı hücre (under) VEYA ayak hizası (kule bir üst).
 */
async function jumpPlaceOnBelow(
  instance: BotInstance,
  target: Vec3,
  item: { name: string },
  wantName: string,
  scaffolds: ScaffoldTracker
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot?.entity) return false;

  // Yerleştirilecek yüzey: target'ın altındaki dolu blok (under için target-1 yok, target zaten under)
  // under: stand on block at target; place replaces under → dig first usually
  // tower: place at feet y while jumping on block at feet-1
  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fy = Math.floor(p.y);
  const fz = Math.floor(p.z);

  // Sadece aynı xz
  if (target.x !== fx || target.z !== fz) return false;

  let support = bot.blockAt(v3(target.x, target.y - 1, target.z));
  let placeTarget = target;

  if (target.y === fy - 1) {
    // ayak altı: alttaki bloğa (target-1) bakıp target'a üst yüzden koy — support = target-1
    support = bot.blockAt(v3(target.x, target.y - 1, target.z));
    placeTarget = target;
    if (!support || isReplaceableBlock(support.name)) {
      // boşluk — kenar referans gerekir, zıpla-koy yetmez
      return false;
    }
  } else if (target.y === fy) {
    // ayak hizası kule: altında durduğu blok üstüne koy
    support = bot.blockAt(v3(fx, fy - 1, fz));
    placeTarget = target;
    if (!support || isReplaceableBlock(support.name)) return false;
  } else {
    return false;
  }

  // hedef dolu ve yanlışsa kır (ayak altı — zıplarken zor; önce kenar dene değilse false)
  const existing = bot.blockAt(placeTarget);
  if (existing && !isReplaceableBlock(existing.name) && !namesMatch(existing.name, wantName)) {
    return false;
  }
  if (existing && namesMatch(existing.name, wantName)) {
    scaffolds.protectStructure(placeTarget.x, placeTarget.y, placeTarget.z);
    return true;
  }

  try {
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* */
    }
    if (bot.heldItem?.name !== item.name) {
      const inv = bot.inventory.items().find((i) => i.name === item.name);
      if (!inv) return false;
      await bot.equip(inv, "hand");
    }

    // tek kontrollü zıpla-koy (spam yok)
    await bot.look(bot.entity.yaw, 1.35, false);
    bot.setControlState("jump", true);
    await sleep(90);
    try {
      await bot.placeBlock(support, v3(0, 1, 0));
      scaffolds.record(placeTarget.x, placeTarget.y, placeTarget.z, item.name);
    } catch {
      const ref = findReference(bot, placeTarget);
      if (ref) {
        try {
          await bot.lookAt(ref.block.position.offset(0.5, 0.5, 0.5), false);
          await bot.placeBlock(ref.block, ref.face);
        } catch {
          /* */
        }
      }
    } finally {
      try {
        bot.setControlState("jump", false);
      } catch {
        /* */
      }
    }
    await sleep(100);

    const after = bot.blockAt(placeTarget);
    if (after && (namesMatch(after.name, wantName) || after.name === item.name || namesMatch(after.name, item.name))) {
      scaffolds.protectStructure(placeTarget.x, placeTarget.y, placeTarget.z);
      return true;
    }
    return false;
  } catch {
    try {
      bot.setControlState("jump", false);
    } catch {
      /* */
    }
    return false;
  }
}

function namesMatch(a: string, b: string): boolean {
  const x = a.replace(/^minecraft:/, "");
  const y = b.replace(/^minecraft:/, "");
  return x === y || x.replace(/_block$/, "") === y.replace(/_block$/, "");
}

function isReplaceableBlock(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "air" ||
    n === "cave_air" ||
    n === "void_air" ||
    n === "water" ||
    n === "lava" ||
    n === "flowing_water" ||
    n === "flowing_lava" ||
    n === "bubble_column" ||
    n === "short_grass" ||
    n === "tall_grass" ||
    n === "grass" ||
    n === "fern" ||
    n === "large_fern" ||
    n === "dead_bush" ||
    n === "snow" ||
    n.includes("fire")
  );
}

function isUnbreakable(name: string): boolean {
  const n = name.replace(/^minecraft:/, "");
  return (
    n === "bedrock" ||
    n === "barrier" ||
    n === "command_block" ||
    n === "chain_command_block" ||
    n === "repeating_command_block" ||
    n === "structure_block" ||
    n === "jigsaw" ||
    n === "end_portal" ||
    n === "end_portal_frame" ||
    n === "nether_portal"
  );
}

/**
 * Hedefteki yanlış bloğu kır (kazma/kürek ile).
 * Başka oyuncunun koyduğu / hatalı path / eski blok.
 */
async function clearBlockAt(
  instance: BotInstance,
  target: Vec3,
  token: TaskToken,
  opts?: { skipPath?: boolean }
): Promise<boolean> {
  const bot = instance.bot;
  if (!bot) return false;
  const b = bot.blockAt(target);
  if (!b || isReplaceableBlock(b.name)) return true;
  if (isUnbreakable(b.name)) return false;

  const feet = bot.entity.position;
  const onFeet =
    Math.floor(feet.x) === target.x && Math.floor(feet.y) === target.y && Math.floor(feet.z) === target.z;
  if (onFeet) {
    try {
      bot.setControlState("back", true);
      await sleep(160);
      bot.setControlState("back", false);
      await sleep(40);
    } catch {
      /* */
    }
    const feet2 = bot.entity.position;
    if (Math.floor(feet2.x) === target.x && Math.floor(feet2.y) === target.y && Math.floor(feet2.z) === target.z) {
      return false;
    }
  }

  const tx = target.x + 0.5;
  const ty = target.y + 0.5;
  const tz = target.z + 0.5;
  if (dist3(bot, tx, ty, tz) > PLACE_REACH) {
    if (opts?.skipPath) return false;
    await pathNear(instance, tx, target.y, tz, PATH_RANGE, token);
  }
  if (token.cancelled) throw new Error(token.reason ?? "iptal");

  const live = bot.blockAt(target);
  if (!live || isReplaceableBlock(live.name)) return true;
  if (!bot.canDigBlock(live)) return false;

  try {
    await equipBestToolForBlock(bot, live);
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), false);
    await bot.dig(live, true);
    await sleep(30);
    const after = bot.blockAt(target);
    return !after || isReplaceableBlock(after.name);
  } catch {
    return false;
  }
}

function findReference(bot: Bot, target: Vec3): { block: Block; face: Vec3 } | null {
  for (const [fx, fy, fz] of FACES) {
    const rp = v3(target.x + fx, target.y + fy, target.z + fz);
    const b = bot.blockAt(rp);
    if (!b || b.name === "air" || b.name === "cave_air" || b.name === "void_air" || b.name === "water" || b.name === "lava") {
      continue;
    }
    const face = v3(-fx, -fy, -fz);
    return { block: b, face };
  }
  return null;
}

async function ensureSupport(
  instance: BotInstance,
  target: Vec3,
  token: TaskToken,
  scaffolds: ScaffoldTracker
) {
  const bot = instance.bot!;
  const under = v3(target.x, target.y - 1, target.z);
  const ub = bot.blockAt(under);
  if (ub && ub.name !== "air" && ub.name !== "cave_air") return;

  const scaffoldName = pickScaffoldItem(bot, instance.config.movement.scaffoldBlocks);
  if (!scaffoldName) return;

  if (dist3(bot, under.x + 0.5, under.y, under.z + 0.5) > PLACE_REACH) {
    await pathNear(instance, under.x + 0.5, under.y, under.z + 0.5, PATH_RANGE, token);
  }
  const item = bot.inventory.items().find((i) => i.name === scaffoldName);
  if (!item) return;

  let ref = findReference(bot, under);
  if (!ref && under.y > -64) {
    await ensureSupport(instance, under, token, scaffolds);
    ref = findReference(bot, under);
  }
  if (!ref) return;
  try {
    if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
    await bot.placeBlock(ref.block, ref.face);
    scaffolds.record(under.x, under.y, under.z, scaffoldName);
    await sleep(40);
  } catch {
    /* */
  }
}

async function climbWithScaffold(
  instance: BotInstance,
  targetFootY: number,
  token: TaskToken,
  scaffolds: ScaffoldTracker
) {
  const bot = instance.bot!;
  const preferred = instance.config.movement.scaffoldBlocks;
  let guard = 0;
  while (!token.cancelled && bot.entity.position.y < targetFootY - 0.5 && guard < 16) {
    guard++;
    const scaffoldName = pickScaffoldItem(bot, preferred);
    if (!scaffoldName) break;
    const item = bot.inventory.items().find((i) => i.name === scaffoldName);
    if (!item) break;

    const fx = Math.floor(bot.entity.position.x);
    const fy = Math.floor(bot.entity.position.y);
    const fz = Math.floor(bot.entity.position.z);
    try {
      if (bot.heldItem?.name !== item.name) await bot.equip(item, "hand");
      const below = bot.blockAt(v3(fx, fy - 1, fz));
      if (below && below.name !== "air") {
        bot.setControlState("jump", true);
        await sleep(120);
        try {
          await bot.placeBlock(below, v3(0, 1, 0));
          scaffolds.record(fx, fy, fz, scaffoldName);
        } catch {
          /* */
        }
        bot.setControlState("jump", false);
        await sleep(140);
      } else {
        break;
      }
    } catch {
      bot.setControlState("jump", false);
      break;
    }
  }
}

import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { creativeEnsureItem } from "../build/creative";
import { boundedOp, digCancelable } from "../build/place";
import { ensureMovement, runGoto, type GotoOptions } from "../movement";
import { ringSearch } from "./ringSearch";
// caya-build-resource-storage-v1: gather
import { collectDropsAfterDig, runSmartCollectBlock, runSmartCollectDrops } from "./smartGather";

const LOG_BLOCKS = new Set([
  "oak_log",
  "birch_log",
  "spruce_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "crimson_stem",
  "warped_stem"
]);

export type CountMode = "add" | "target";

interface DigOptions {
  pickup?: boolean;
  canDigRoute?: boolean;
  allowPlaceRoute?: boolean;
  breakOnly?: (name: string) => boolean;
}

/**
 * Kaynak toplama (Faz 8): yüzey-ağaç planlayıcısı, ground items ve madencilik.
 *
 * Miktar semantiği:
 * - add: mevcut inventorye belirtilen miktarı EKLER.
 * - target: inventory toplamını belirtilen miktara ulaştırır.
 */
export class GatherService {
  constructor(private readonly instance: BotInstance) {}

  private log() {
    return this.instance.getLogger();
  }

  enqueueCollectWood(
    count = 16,
    logType?: string,
    priority: number = PRIORITY.AUTO,
    countMode: CountMode = "add"
  ) {
    const n = Math.max(1, Math.min(256, Math.floor(count)));
    const modeText = countMode === "add" ? `+${n}` : `target ${n}`;
    return this.instance.tasks.enqueue(
      {
        type: "collect-wood",
        label: `odun topla ${modeText}${logType ? ` (${logType})` : ""}`,
        priority,
        params: { count: n, logType: logType ?? null, countMode },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectWood(n, logType, token, report, countMode)
    );
  }

  enqueueCollectDrops(filter?: string, radius = 16, priority: number = PRIORITY.USER) {
    return this.instance.tasks.enqueue(
      {
        type: "collect-drops",
        label: `ground items${filter ? `: ${filter}` : ""}`,
        priority,
        params: { filter: filter ?? null, radius },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectDrops(filter, radius, token, report)
    );
  }

  enqueueMine(
    ore: string,
    count = 8,
    mode: "legit" | "utility" = "legit",
    priority: number = PRIORITY.AUTO,
    countMode: CountMode = "add"
  ) {
    const n = Math.max(1, Math.min(128, Math.floor(count)));
    const modeText = countMode === "add" ? `+${n}` : `target ${n}`;
    return this.instance.tasks.enqueue(
      {
        type: "mine",
        label: `maden: ${ore} ${modeText} (${mode})`,
        priority,
        params: { ore, count: n, mode, countMode },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runMine(ore, n, mode, token, report, countMode)
    );
  }

  /** Akıllı kaynak planlayıcısı: odun/maden/craft/doğrudan blok stratejisini seçer. */
  enqueueCollectBlock(
    blockOrItem: string,
    count = 16,
    priority: number = PRIORITY.USER,
    countMode: CountMode = "add"
  ) {
    const n = Math.max(1, Math.min(256, Math.floor(count)));
    const name = blockOrItem.replace(/^minecraft:/, "");
    const modeText = countMode === "add" ? `+${n}` : `target ${n}`;
    return this.instance.tasks.enqueue(
      {
        type: "collect-block",
        label: `topla ${name} ${modeText}`,
        priority,
        params: { name, count: n, countMode },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runCollectBlock(name, n, token, report, countMode)
    );
  }

  async runCollectWood(
    amount: number,
    logType: string | undefined,
    token: TaskToken,
    report: ProgressFn,
    countMode: CountMode = "add"
  ) {
    const bot = this.requireBot();
    const match = (name: string) =>
      logType ? name === logType : LOG_BLOCKS.has(name) || name.endsWith("_log") || name.endsWith("_stem");
    const countNow = () => this.countItems(bot, match);
    const start = countNow();
    const target = countMode === "add" ? start + Math.max(1, amount) : Math.max(1, amount);
    const requestedDelta = Math.max(0, target - start);
    const blockedTrees = new Map<string, number>();
    let noProgressTrees = 0;

    const reportProgress = (label?: string) => {
      const current = countNow();
      const gained = Math.max(0, current - start);
      report({
        done: Math.min(gained, requestedDelta),
        total: requestedDelta,
        label: label ?? `odun +${gained}/${requestedDelta} · inventory ${current}/${target}`
      });
    };

    reportProgress(`searching surface trees · inventory ${start}, target ${target}`);
    if (start >= target) {
      this.log().success(`Wood target already met (${start}/${target})`);
      return;
    }

    while (countNow() < target && !token.cancelled) {
      let base = this.findTreeBase(bot, match, 40, blockedTrees);
      if (!base) {
        const found = await ringSearch(this.instance, token, report, {
          step: 24,
          maxRadius: 144,
          surfaceTravel: true,
          movement: { canDig: false, allowPlace: false, parkour: true, timeoutMs: 45_000 },
          probe: (probeBot) => Boolean(this.findTreeBase(probeBot, match, 28, blockedTrees))
        });
        if (!found) throw new Error("No reachable surface tree found (no terrain dig)");
        base = this.findTreeBase(bot, match, 40, blockedTrees);
      }
      if (!base) continue;

      const baseKey = posKey(base.position);
      const before = countNow();
      reportProgress(`cutting tree: ${base.name} @ ${base.position.x},${base.position.y},${base.position.z}`);

      try {
        const remaining = Math.max(1, target - before);
        const dug = await this.harvestReachableTree(bot, base, match, remaining, token, reportProgress);
        if (dug <= 0) throw new Error("could not dig accessible tree trunk");
        // Yaprak drop'undaki fidanı da al; logType filtresi sapling'i kaçırır.
        await collectDropsAfterDig(this.instance, undefined, token);
        await this.tryReplant(bot, base.position, base.name, token, reportProgress);
      } catch (error) {
        const failures = (blockedTrees.get(baseKey) ?? 0) + 1;
        blockedTrees.set(baseKey, failures);
        this.log().warn(
          `Tree candidate skipped (${failures}/2)`,
          error instanceof Error ? error.message : String(error)
        );
      }

      const after = countNow();
      if (after <= before) {
        noProgressTrees += 1;
        blockedTrees.set(baseKey, Math.max(2, blockedTrees.get(baseKey) ?? 0));
        if (noProgressTrees >= 6) {
          throw new Error("Tree cut but wood not in inventory; unreachable candidates exhausted");
        }
      } else {
        noProgressTrees = 0;
      }
      reportProgress();
    }

    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    this.log().success(`Odun toplama bitti (+${countNow() - start}, inventory ${countNow()})`);
  }

  async runCollectDrops(filter: string | undefined, radius: number, token: TaskToken, report: ProgressFn) {
    const picked = await runSmartCollectDrops(this.instance, filter, radius, token, report);
    this.log().success(`Ground item pickup (verified: ${picked})`);
  }

  async runCollectBlock(
    name: string,
    amount: number,
    token: TaskToken,
    report: ProgressFn,
    countMode: CountMode = "add"
  ) {
    await runSmartCollectBlock(this.instance, name, amount, token, report, countMode);
    this.log().success(`Smart gather finished: ${name} · ${countMode === "add" ? "+" : "target "}${amount}`);
  }

  async runMine(
    ore: string,
    amount: number,
    mode: "legit" | "utility",
    token: TaskToken,
    report: ProgressFn,
    countMode: CountMode = "add"
  ) {
    const bot = this.requireBot();
    const oreName = normalizeOreName(ore);
    const blockNames = oreVariants(oreName);
    const inventoryNames = oreInventoryNames(oreName);
    const countNow = () => this.countItems(bot, (name) => inventoryNames.has(name));
    const start = countNow();
    const target = countMode === "add" ? start + Math.max(1, amount) : Math.max(1, amount);
    const requestedDelta = Math.max(0, target - start);
    let got = start;
    report({ done: 0, total: requestedDelta, label: `${oreName}: inventory ${start}, target ${target}` });

    if (got >= target) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const toolPlugin = require("mineflayer-tool").plugin;
      if (!(bot as unknown as { tool?: unknown }).tool) bot.loadPlugin(toolPlugin);
    } catch {
      /* optional */
    }

    let skippedLava = 0;
    while (got < target && !token.cancelled) {
      let block = bot.findBlock({
        matching: (candidate) => blockNames.includes(candidate.name),
        maxDistance: mode === "utility" ? 64 : 32
      });

      if (!block && mode === "legit") {
        const found = await ringSearch(this.instance, token, report, {
          step: 20,
          maxRadius: 96,
          movement: { canDig: true, allowPlace: true, parkour: true, timeoutMs: 60_000 },
          probe: (probeBot) =>
            Boolean(
              probeBot.findBlock({
                matching: (candidate) => blockNames.includes(candidate.name),
                maxDistance: 18
              })
            )
        });
        if (!found) throw new Error(`${oreName} ore not found`);
        block = bot.findBlock({
          matching: (candidate) => blockNames.includes(candidate.name),
          maxDistance: 36
        });
      }

      if (!block) throw new Error(`${oreName} ore block missing`);

      if (this.hasLavaNear(bot, block.position)) {
        skippedLava += 1;
        if (skippedLava >= 8) throw new Error(`${oreName}: unsafe lava-adjacent candidates exhausted`);
        this.log().warn("Near lava — ore skipped");
        await sleep(180);
        continue;
      }
      skippedLava = 0;

      await this.digBlock(bot, block, token, { canDigRoute: true, allowPlaceRoute: true });
      got = countNow();
      report({
        done: Math.min(Math.max(0, got - start), requestedDelta),
        total: requestedDelta,
        label: `${oreName} +${Math.max(0, got - start)}/${requestedDelta} · inventory ${got}/${target}`
      });
    }
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    this.log().success(`Madencilik done: ${oreName} +${got - start} (inventory ${got})`);
  }

  private findTreeBase(
    bot: Bot,
    match: (name: string) => boolean,
    maxDistance: number,
    blocked: Map<string, number>
  ): Block | null {
    const positions = bot.findBlocks({
      matching: (block) => match(block.name),
      maxDistance,
      count: 256
    });
    const unique = new Map<string, Block>();

    for (const position of positions) {
      let current = bot.blockAt(position);
      if (!current || !match(current.name)) continue;
      // Aynı gövde kolonunun en alt log'una in; üstteki yaprak içi loglara kilitlenme.
      for (let i = 0; i < 20; i += 1) {
        const below = bot.blockAt(current.position.offset(0, -1, 0));
        if (!below || !match(below.name)) break;
        current = below;
      }
      const key = posKey(current.position);
      if ((blocked.get(key) ?? 0) >= 2) continue;
      unique.set(key, current);
    }

    const here = bot.entity.position;
    const candidates = [...unique.values()].filter((block) => {
      const below = bot.blockAt(block.position.offset(0, -1, 0));
      if (!below || below.boundingBox === "empty") return false; // floating/player decoration
      const exposed = HORIZONTAL.some(([x, z]) => {
        const side = bot.blockAt(block.position.offset(x, 0, z));
        return !side || side.boundingBox === "empty" || side.name.includes("leaves") || side.name === "vine";
      });
      return exposed;
    });

    candidates.sort((a, b) => treeScore(here, a) - treeScore(here, b));
    return candidates[0] ?? null;
  }

  private async harvestReachableTree(
    bot: Bot,
    base: Block,
    match: (name: string) => boolean,
    remaining: number,
    token: TaskToken,
    report: (label?: string) => void
  ): Promise<number> {
    // Arazi kazma kapalı; yalnızca yaprak/vine ile tünel açılır ki gövdeye girilebilsin.
    await runGoto(
      this.instance,
      base.position.x,
      base.position.y,
      base.position.z,
      2,
      token,
      () => {},
      TREE_MOVE
    );

    report("clearing leaves around trunk");
    await this.clearFoliageWorkspace(bot, base.position, token);

    const positions = bot.findBlocks({
      matching: (block) => match(block.name),
      point: base.position,
      maxDistance: 8,
      count: 96
    });
    const connected = connectedTreePositions(bot, base.position, positions, match)
      .sort((a, b) => a.y - b.y || bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
      .slice(0, Math.min(32, remaining + 4));

    let dug = 0;
    let misses = 0;
    for (const position of connected) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      const live = bot.blockAt(position);
      if (!live || !match(live.name)) continue;
      try {
        report(`cutting trunk ${dug + 1}/${Math.min(connected.length, remaining)}`);
        await this.digTreeBlock(bot, live, token, report);
        dug += 1;
        misses = 0;
        if (dug >= remaining) break;
      } catch (error) {
        misses += 1;
        const msg = error instanceof Error ? error.message : String(error);
        // Tepedeki log yerden yetişmiyorsa aynı ağacın daha yükseklerine takılma.
        if (msg.includes("too high") || misses >= 5) break;
      }
    }
    return dug;
  }

  /** Gövdeye bakışı kesen yaprakları ve ayak/baş hücresindeki canopy'yi temizle. */
  private async clearFoliageWorkspace(bot: Bot, trunk: Vec3, token: TaskToken): Promise<void> {
    const feet = bot.entity.position.floored();
    const seen = new Set<string>();
    const candidates: Block[] = [];
    const consider = (block: Block | null) => {
      if (!block || !isTreeObstacle(block.name)) return;
      const key = posKey(block.position);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(block);
    };

    consider(bot.blockAt(feet));
    consider(bot.blockAt(feet.offset(0, 1, 0)));
    for (const [dx, dz] of HORIZONTAL) {
      for (const dy of [0, 1, 2, 3, 4, 5, 6]) {
        consider(bot.blockAt(trunk.offset(dx, dy, dz)));
      }
    }
    // Bot ile gövde arasındaki hücreler.
    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      consider(
        bot.blockAt(
          new Vec3(
            Math.floor(feet.x + (trunk.x - feet.x) * t),
            Math.floor(feet.y + (trunk.y - feet.y) * t),
            Math.floor(feet.z + (trunk.z - feet.z) * t)
          )
        )
      );
    }

    candidates.sort(
      (a, b) =>
        bot.entity.position.distanceTo(a.position.offset(0.5, 0.5, 0.5)) -
        bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5))
    );

    let cleared = 0;
    for (const block of candidates) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      if (cleared >= 12) break;
      const live = bot.blockAt(block.position);
      if (!live || !isTreeObstacle(live.name)) continue;
      if (!bot.canDigBlock(live)) continue;
      try {
        await this.equipFor(bot, live);
        await this.timedDig(bot, live, token);
        cleared += 1;
      } catch {
        /* workspace clear is best-effort */
      }
    }
  }

  /**
   * Gövdeyi kaz. Tepedeki log'a 3D GoalNear (gökyüzüne yürüme) YOK —
   * yere basıp pitch yukarı, gerekirse zıpla. Bakış tutmazsa kazma başlatma.
   */
  private async digTreeBlock(bot: Bot, block: Block, token: TaskToken, report: (label?: string) => void): Promise<void> {
    const pos = new Vec3(Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z));
    let approached = false;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      const live = bot.blockAt(pos);
      if (!live || live.boundingBox === "empty") return;

      const center = live.position.offset(0.5, 0.5, 0.5);
      const feetY = Math.floor(bot.entity.position.y);
      const horiz = Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z);
      const eyeDist = eyeDistance(bot, center);
      const above = live.position.y > feetY + 2;

      if (!approached && (horiz > 2.2 || (above && horiz > 1.55))) {
        await this.approachTrunkColumn(bot, pos, token);
        approached = true;
        continue;
      }

      this.stopPath(bot);
      await this.snapLookAt(bot, center, token);

      const hit = blockAtCursor(bot, 5.5);
      if (hit && sameBlock(hit.position, pos) && eyeDist <= 5.15) {
        await this.equipFor(bot, live);
        await this.timedDig(bot, live, token);
        if (!bot.blockAt(pos) || bot.blockAt(pos)?.boundingBox === "empty") return;
        continue;
      }

      const foliage = (hit && isTreeObstacle(hit.name) ? hit : null) ?? foliageToward(bot, pos);
      if (foliage && bot.canDigBlock(foliage)) {
        report(`clearing ${foliage.name} to reach trunk`);
        try {
          await this.snapLookAt(bot, foliage.position.offset(0.5, 0.5, 0.5), token);
          await this.equipFor(bot, foliage);
          await this.timedDig(bot, foliage, token);
        } catch {
          /* next angle */
        }
        continue;
      }

      // Tepedeki odun: yerden bakış yetmezse zıplayıp tekrar nişan al.
      if (above && eyeDist <= 6.3) {
        report(`looking up · jump-mine ${live.name}`);
        const mined = await this.jumpMine(bot, live, token);
        if (mined) return;
      }

      if (eyeDist > 5.4 && attempt >= 1) {
        throw new Error(`${live.name} too high to reach`);
      }

      if (horiz > 1.4 && attempt <= 2) {
        await this.approachTrunkColumn(bot, pos, token);
        approached = true;
      }
    }

    const leftover = bot.blockAt(pos);
    if (leftover && leftover.boundingBox !== "empty") {
      throw new Error(`${leftover.name} still blocked after leaf clear`);
    }
  }

  /** Üst log'a uçmaya çalışma — gövde kolonunun yanına, botun Y'sinde dur. */
  private async approachTrunkColumn(bot: Bot, log: Vec3, token: TaskToken): Promise<void> {
    const feetY = Math.floor(bot.entity.position.y);
    const standY = log.y > feetY + 1 ? feetY : Math.floor(log.y);
    const dy = Math.max(0, Math.floor(log.y) - feetY);
    const range = dy >= 3 ? 1 : 2;
    const horiz = Math.hypot(bot.entity.position.x - (log.x + 0.5), bot.entity.position.z - (log.z + 0.5));
    if (horiz <= range + 0.35 && Math.abs(bot.entity.position.y - standY) < 1.8) return;
    await runGoto(this.instance, log.x, standY, log.z, range, token, () => {}, {
      ...TREE_MOVE,
      timeoutMs: 10_000
    });
    this.stopPath(bot);
  }

  private stopPath(bot: Bot) {
    try {
      const pf = bot.pathfinder as unknown as { setGoal?(g: null): void; stop?(): void };
      pf.stop?.();
      pf.setGoal?.(null);
    } catch {
      /* */
    }
  }

  private async snapLookAt(bot: Bot, point: Vec3, token: TaskToken): Promise<void> {
    this.stopPath(bot);
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const dx = point.x - eye.x;
    const dy = point.y - eye.y;
    const dz = point.z - eye.z;
    const ground = Math.sqrt(dx * dx + dz * dz) || 0.001;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, ground);
    try {
      await boundedOp(bot.look(yaw, pitch, true), token, 400, "look");
    } catch {
      try {
        bot.entity.yaw = yaw;
        bot.entity.pitch = pitch;
      } catch {
        /* */
      }
    }
    await sleep(50);
  }

  private async jumpMine(bot: Bot, live: Block, token: TaskToken): Promise<boolean> {
    const pos = live.position.clone();
    const center = pos.offset(0.5, 0.5, 0.5);
    try {
      bot.setControlState("jump", true);
      await sleep(200);
      await this.snapLookAt(bot, center, token);
      const current = bot.blockAt(pos);
      if (!current || current.boundingBox === "empty") return true;
      const hit = blockAtCursor(bot, 5.5);
      const dist = eyeDistance(bot, center);
      if ((hit && sameBlock(hit.position, pos)) || (dist <= 5.2 && bot.canDigBlock(current))) {
        await this.equipFor(bot, current);
        bot.setControlState("jump", false);
        await this.timedDig(bot, current, token);
        return !bot.blockAt(pos) || bot.blockAt(pos)?.boundingBox === "empty";
      }
      return false;
    } finally {
      try {
        bot.setControlState("jump", false);
      } catch {
        /* */
      }
    }
  }

  private async tryReplant(
    bot: Bot,
    base: Vec3,
    logName: string,
    token: TaskToken,
    report: (label?: string) => void
  ) {
    const wanted = saplingForLog(logName);
    if (!wanted) return;
    await creativeEnsureItem(bot, wanted, 1);
    const sap = bot.inventory.items().find((item) => item.name === wanted) ?? null;
    if (!sap) return;

    try {
      report(`replant ${wanted} @ ${Math.floor(base.x)},${Math.floor(base.y)},${Math.floor(base.z)}`);
      try {
        await runGoto(this.instance, base.x, base.y, base.z, 2, token, () => {}, {
          ...TREE_MOVE,
          timeoutMs: 12_000
        });
      } catch {
        /* already nearby is fine */
      }
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");

      const occupant = bot.blockAt(base);
      if (occupant && isTreeObstacle(occupant.name) && bot.canDigBlock(occupant)) {
        await this.equipFor(bot, occupant);
        await this.timedDig(bot, occupant, token);
      }

      const dirt = bot.blockAt(base.offset(0, -1, 0));
      const air = bot.blockAt(base);
      if (!dirt || !air || air.boundingBox !== "empty") return;
      const above = bot.blockAt(base.offset(0, 1, 0));
      if (above && (above.name.endsWith("_log") || above.name.endsWith("_stem"))) return;
      if (!isPlantableGround(dirt.name, wanted)) return;

      const liveSap = bot.inventory.items().find((item) => item.name === wanted);
      if (!liveSap) return;
      await boundedOp(bot.equip(liveSap, "hand"), token, 4_000, "equip sapling");
      await boundedOp(bot.lookAt(dirt.position.offset(0.5, 1, 0.5), true), token, 1_500, "look replant");
      await boundedOp(bot.placeBlock(dirt, new Vec3(0, 1, 0)), token, 4_000, "replant sapling", () => {
        try {
          bot.clearControlStates();
        } catch {
          /* */
        }
      });
    } catch {
      /* replant best-effort — wood job must not fail because plant missed */
    }
  }

  private async digBlock(bot: Bot, block: Block | { position: { x: number; y: number; z: number }; name: string }, token: TaskToken, options: DigOptions = {}) {
    const pos = new Vec3(Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z));
    const beforeMove = bot.blockAt(pos);
    const alreadyReachable = Boolean(
      beforeMove &&
      bot.entity.position.distanceTo(beforeMove.position.offset(0.5, 0.5, 0.5)) <= 4.6 &&
      bot.canDigBlock(beforeMove)
    );

    // Aynı ağacın yan ymain gövdelerinde her blok for yeniden path hesaplamak çok
    // yavaştı. El menzilindeyse doğrudan kaz; yalnızca gerektiğinde yaklaş.
    if (!alreadyReachable) {
      await runGoto(
        this.instance,
        block.position.x,
        block.position.y,
        block.position.z,
        3,
        token,
        () => {},
        {
          canDig: options.canDigRoute ?? true,
          allowPlace: options.allowPlaceRoute ?? true,
          parkour: true,
          timeoutMs: options.canDigRoute === false ? 45_000 : 90_000,
          breakOnly: options.breakOnly
        }
      );
    }
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");
    ensureMovement(this.instance, {
      mode: "goto",
      canDig: options.canDigRoute ?? true,
      allowPlace: options.allowPlaceRoute ?? true,
      breakOnly: options.breakOnly
    });
    const live = bot.blockAt(pos);
    if (!live) return;
    await this.equipFor(bot, live);
    if (bot.heldItem && this.instance.config.inventory.bannedItems.includes(bot.heldItem.name)) {
      throw new Error(`Held tool is banned: ${bot.heldItem.name}`);
    }
    if (!bot.canDigBlock(live)) throw new Error(`${live.name} cannot dig from this position`);
    await this.timedDig(bot, live, token);
    if (options.pickup !== false) await collectDropsAfterDig(this.instance, live.name, token);
  }

  private async equipFor(bot: Bot, block: Block) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const toolPlugin = require("mineflayer-tool").plugin;
      if (!(bot as unknown as { tool?: unknown }).tool) bot.loadPlugin(toolPlugin);
      const toolBot = bot as unknown as { tool?: { equipForBlock(block: unknown): Promise<void> } };
      if (toolBot.tool) await boundedOp(toolBot.tool.equipForBlock(block), null, 3_000, "equip tool");
    } catch {
      /* no tool plugin */
    }
    if (bot.heldItem && this.instance.config.inventory.bannedItems.includes(bot.heldItem.name)) {
      throw new Error(`Held tool is banned: ${bot.heldItem.name}`);
    }
  }

  private async timedDig(bot: Bot, block: Block, token: TaskToken) {
    const wait = typeof bot.digTime === "function" ? bot.digTime(block) : 1_000;
    const ms = Math.max(3_000, Math.min(12_000, (Number.isFinite(wait) ? wait : 1_000) + 3_500));
    await boundedOp(digCancelable(bot, block, token), token, ms, `dig ${block.name}`, () => {
      try {
        (bot as unknown as { stopDigging?(): void }).stopDigging?.();
      } catch {
        /* */
      }
    });
  }

  private hasLavaNear(bot: Bot, pos: { x: number; y: number; z: number }) {
    for (const [x, y, z] of NEIGHBORS) {
      const block = bot.blockAt(new Vec3(pos.x + x, pos.y + y, pos.z + z));
      if (block && (block.name === "lava" || block.name === "flowing_lava")) return true;
    }
    return false;
  }

  private countItems(bot: Bot, pred: (name: string) => boolean) {
    return bot.inventory.items().reduce((sum, item) => sum + (pred(item.name) ? item.count : 0), 0);
  }

  private requireBot(): Bot {
    const bot = this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot offline");
    return bot;
  }
}

const HORIZONTAL: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];
const NEIGHBORS: Array<[number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
];

const TREE_MOVE: GotoOptions = {
  canDig: false,
  allowPlace: false,
  parkour: true,
  timeoutMs: 45_000,
  breakOnly: isTreeObstacle
};

function isTreeObstacle(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes("leaves") || n.includes("leaf")) return true;
  if (n === "vine" || n.includes("vines")) return true;
  if (n === "cocoa") return true;
  if (n.includes("mangrove_roots")) return true;
  if (n === "azalea" || n === "flowering_azalea") return true;
  if (n === "nether_wart_block" || n === "warped_wart_block" || n === "shroomlight") return true;
  if (n === "moss_carpet") return true;
  return false;
}

function saplingForLog(logName: string): string | null {
  const n = logName.replace(/^minecraft:/, "");
  if (n === "mangrove_log") return "mangrove_propagule";
  if (n.endsWith("_stem")) return n.replace(/_stem$/, "_fungus");
  if (n.endsWith("_log")) return n.replace(/_log$/, "_sapling");
  return null;
}

function isPlantableGround(blockName: string, sapling: string): boolean {
  const n = blockName.toLowerCase();
  const dirtLike =
    n.includes("dirt") ||
    n.includes("grass") ||
    n === "podzol" ||
    n === "mycelium" ||
    n === "mud" ||
    n === "moss_block" ||
    n === "farmland";
  if (sapling.endsWith("_fungus")) return dirtLike || n.includes("nylium") || n === "soul_soil";
  if (sapling === "mangrove_propagule") return dirtLike || n === "mud" || n.includes("mangrove_roots") || n === "clay";
  return dirtLike;
}

function eyeDistance(bot: Bot, point: Vec3): number {
  return bot.entity.position.offset(0, 1.62, 0).distanceTo(point);
}

function sameBlock(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);
}

function blockAtCursor(bot: Bot, max = 5.5): Block | null {
  try {
    const cursorBot = bot as unknown as { blockAtCursor?: (max?: number) => Block | null };
    return cursorBot.blockAtCursor?.(max) ?? null;
  } catch {
    return null;
  }
}

/** Gözden target log'a doğru ilk yaprak; yoksa logun bota bakan yüzündeki yaprak. */
function foliageToward(bot: Bot, target: Vec3): Block | null {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const dest = target.offset(0.5, 0.5, 0.5);
  const dir = dest.minus(eye);
  const dist = dir.norm();
  if (dist < 0.05) return null;
  const steps = Math.max(4, Math.ceil(dist / 0.2));
  const seen = new Set<string>();
  for (let i = 1; i < steps; i += 1) {
    const p = eye.plus(dir.scaled(i / steps));
    const block = bot.blockAt(p);
    if (!block) continue;
    const key = posKey(block.position);
    if (seen.has(key)) continue;
    seen.add(key);
    if (sameBlock(block.position, target)) break;
    if (isTreeObstacle(block.name)) return block;
    if (block.boundingBox !== "empty") return null;
  }
  const dx = Math.sign(Math.round(eye.x - (target.x + 0.5)));
  const dz = Math.sign(Math.round(eye.z - (target.z + 0.5)));
  const sides: Array<[number, number, number]> = [
    [dx || 1, 0, 0],
    [0, 0, dz || 1],
    [0, 1, 0],
    [-(dx || 1), 0, 0],
    [0, 0, -(dz || 1)]
  ];
  for (const [x, y, z] of sides) {
    const side = bot.blockAt(target.offset(x, y, z));
    if (side && isTreeObstacle(side.name) && bot.canDigBlock(side)) return side;
  }
  return null;
}

function treeScore(origin: Vec3, block: Block): number {
  const horizontal = Math.hypot(origin.x - block.position.x, origin.z - block.position.z);
  const vertical = Math.abs(origin.y - block.position.y);
  // Yakın ama tepenin forde remaining log yerine doğal, benzer seviyedeki gövdeyi seç.
  return horizontal + vertical * 2.5 + (block.position.y > origin.y + 12 ? 24 : 0);
}

function connectedTreePositions(bot: Bot, base: Vec3, positions: Vec3[], match: (name: string) => boolean): Vec3[] {
  const available = new Map<string, Vec3>();
  for (const position of positions) {
    const live = bot.blockAt(position);
    if (live && match(live.name)) available.set(posKey(position), position.clone());
  }
  available.set(posKey(base), base.clone());

  const result: Vec3[] = [];
  const queue: Vec3[] = [base.clone()];
  const seen = new Set<string>();
  while (queue.length > 0 && result.length < 64) {
    const current = queue.shift()!;
    const key = posKey(current);
    if (seen.has(key) || !available.has(key)) continue;
    seen.add(key);
    result.push(current);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const next = current.offset(dx, dy, dz);
          const nextKey = posKey(next);
          if (!seen.has(nextKey) && available.has(nextKey)) queue.push(next);
        }
      }
    }
  }
  return result;
}

function normalizeOreName(ore: string): string {
  return ore
    .replace(/^minecraft:/, "")
    .replace(/^deepslate_/, "")
    .replace(/_ore$/, "")
    .replace(/^raw_/, "")
    .replace(/_ingot$/, "");
}

function oreVariants(ore: string): string[] {
  const o = normalizeOreName(ore);
  if (o === "nether_gold") return ["nether_gold_ore"];
  if (o === "quartz") return ["nether_quartz_ore"];
  if (o === "ancient_debris") return ["ancient_debris"];
  return [`${o}_ore`, `deepslate_${o}_ore`];
}

function oreInventoryNames(ore: string): Set<string> {
  const o = normalizeOreName(ore);
  if (o === "ancient_debris") return new Set(["ancient_debris", "netherite_scrap", "netherite_ingot"]);
  if (o === "quartz") return new Set(["quartz", "nether_quartz_ore"]);
  if (o === "nether_gold") return new Set(["gold_nugget", "nether_gold_ore"]);
  if (["iron", "gold", "copper"].includes(o)) {
    return new Set([`raw_${o}`, `${o}_ingot`, `${o}_ore`, `deepslate_${o}_ore`, `raw_${o}_block`]);
  }
  if (["diamond", "emerald", "coal", "lapis", "redstone"].includes(o)) {
    return new Set([o, `${o}_ore`, `deepslate_${o}_ore`, `${o}_block`]);
  }
  return new Set([o, `${o}_ore`, `deepslate_${o}_ore`, `raw_${o}`, `${o}_ingot`]);
}

function posKey(pos: { x: number; y: number; z: number }) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { ringSearch } from "./ringSearch";

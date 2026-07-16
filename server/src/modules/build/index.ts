import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { runSmartCollectDrops } from "../gather/smartGather";
import { shouldSkipBlock } from "./blocks";
import { creativeEnsureItem, isCreativeMode } from "./creative";
import { JobBoard, orderBlocksPrinter, type BuildJob } from "./jobs";
import { loadParsedSchematic, materialCounts } from "./library";
import { isReplaceableBlock, namesMatch, sleep } from "./maneuver";
import { distToBlock, itemNameForBlock, pathNear, placeBlockAt, PLACE_REACH } from "./place";
import { cleanupScaffolds, ScaffoldTracker } from "./scaffold";
import { ChestStockIndex, fetchFromStorage, inventorySpaceFor, makeInventoryRoom, scanNearbyStorage } from "./stock";
import { withdrawBuildMaterials } from "./storage";
import { normalizeRotateY, type BuildTransform, type RotateY } from "./transform";
import {
  emptyBuildRuntime,
  normalizePlaceOrder,
  type BuildOrigin,
  type BuildPlaceOrder,
  type BuildPlacedBlock,
  type BuildRuntime,
  type MaterialNeed,
  type SchematicBlock
} from "./types";
import { v3 } from "./vec3util";

/**
 * Faz 14–17 — schematic construction engine.
 * Issue #3 rewrite: chest stock ledger, 3D-printer layer mode, stall watchdog,
 * mid-build repair, creative support, reconnect resume, honest scaffold cleanup.
 */

interface BuildOpts {
  schematicId: string;
  origin: BuildOrigin;
  allowPartial?: boolean;
  /** acquire missing materials before/while building */
  collectMissing?: boolean;
  /** placement strategy (default printer) */
  placeOrder?: BuildPlaceOrder | string;
  versionHint?: string;
  rotateY?: RotateY | number;
  mirrorX?: boolean;
  mirrorZ?: boolean;
  /** auto-resume this build after a disconnect (default true) */
  resumeOnReconnect?: boolean;
}

interface BuildSession {
  schematicId: string;
  origin: { x: number; y: number; z: number };
  opts: BuildOpts;
  resumeOnReconnect: boolean;
  startedAt: number;
}

/** Everything the placement loop needs (also reused by the verify pass). */
interface LoopCtx {
  token: TaskToken;
  report: ProgressFn;
  board: JobBoard;
  needLedger: Map<string, number>;
  creative: boolean;
  allowPartial: boolean;
  collectMissing: boolean;
  placeOrder: BuildPlaceOrder;
  schematicName: string;
}

const ACTIVE_PHASES = new Set(["preparing", "acquiring", "building", "verifying", "cleanup"]);
const STALL_MS = 25_000;
const REPAIR_TICK_MS = 12_000;
/** World-search budget per material — an unfindable block must not eat the whole build (issue #3 "loop" feel). */
const MATERIAL_GATHER_BUDGET_MS = 120_000;

/** Token that also cancels when a time budget runs out (structural TaskToken). */
function budgetToken(parent: TaskToken, budgetMs: number, reason: string): TaskToken {
  const deadline = Date.now() + budgetMs;
  return {
    get cancelled() {
      return parent.cancelled || Date.now() > deadline;
    },
    get reason() {
      return parent.cancelled ? parent.reason : Date.now() > deadline ? reason : undefined;
    }
  };
}

export class BuildService {
  private runtime: BuildRuntime = emptyBuildRuntime();
  private scaffolds = new ScaffoldTracker();
  /** live chest/shulker stock ledger (survival material planning) */
  readonly stock = new ChestStockIndex();
  private session: BuildSession | null = null;
  private lastScanAt: number | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  /**
   * Service-level cancel gate. stop/hardReset trip this so fire-and-forget
   * pathfinding (scaffold cleanup, mid-await place) cannot keep the bot stuck
   * after the user aborts — even if the TaskQueue token is already cancelled.
   */
  private cancelGate: { cancelled: boolean; reason?: string } = { cancelled: false };
  /** Bumped on stop/reset and when a new run claims the engine — stale catch blocks must not clobber UI. */
  private runId = 0;
  /** Bumped to cancel pending re-freeze timers (must not kill a new goto/build after reset). */
  private freezeEpoch = 0;
  /** True while runBuild is on the call stack (including hung dig/pathNear). */
  private runnerActive = false;

  constructor(private readonly instance: BotInstance) {}

  // ---------------------------------------------------------------- runtime & UI

  getRuntime(): BuildRuntime {
    return {
      ...this.runtime,
      materials: this.runtime.materials.map((m) => ({ ...m })),
      origin: this.runtime.origin ? { ...this.runtime.origin } : null,
      lastBlock: this.runtime.lastBlock ? { ...this.runtime.lastBlock } : null,
      recentBlocks: this.runtime.recentBlocks.map((b) => ({ ...b })),
      transform: { ...this.runtime.transform },
      storage: this.stock.toInfo(this.lastScanAt)
    };
  }

  private lastEmitAt = 0;
  private pendingEmit = false;

  private emit(force = false) {
    const now = Date.now();
    // a socket event per block froze the UI — throttle
    if (!force && now - this.lastEmitAt < 120) {
      this.pendingEmit = true;
      return;
    }
    this.lastEmitAt = now;
    this.pendingEmit = false;
    this.instance.emit("build", { botId: this.instance.config.id, build: this.getRuntime() });
  }

  private flushEmit() {
    if (this.pendingEmit) this.emit(true);
  }

  private log() {
    return this.instance.getLogger();
  }

  private setPhase(phase: BuildRuntime["phase"], label?: string, error?: string) {
    this.runtime.phase = phase;
    if (label != null) this.runtime.label = label;
    if (error != null) this.runtime.error = error;
    // terminal phases must not keep a stall badge / activity strip
    if (phase === "failed" || phase === "cancelled" || phase === "done" || phase === "idle") {
      this.runtime.stuck = null;
      if (phase !== "done") {
        this.runtime.activity = null;
        this.runtime.activityMaterial = null;
      }
    }
    this.emit(true);
  }

  private setActivity(text: string | null, material?: string | null) {
    this.runtime.activity = text;
    this.runtime.activityMaterial = material ?? null;
    if (text) this.runtime.label = text;
    this.emit(true);
  }

  /** Immediately release pathfinder / dig / movement keys so the bot is free. */
  private freezeBot() {
    const bot = this.instance.bot;
    if (!bot) return;
    try {
      const pf = bot.pathfinder as unknown as { setGoal?(g: null): void; stop?(): void };
      pf.stop?.();
      pf.setGoal?.(null);
    } catch {
      /* */
    }
    try {
      (bot as unknown as { stopDigging?(): void }).stopDigging?.();
    } catch {
      /* */
    }
    try {
      bot.clearControlStates();
    } catch {
      /* */
    }
    try {
      const win = (bot as { currentWindow?: { id?: number } | null }).currentWindow;
      if (win) bot.closeWindow(win as never);
    } catch {
      /* */
    }
  }

  /** Arm a fresh gate for a new build run (after a previous abort). */
  private armCancelGate() {
    this.cancelGate = { cancelled: false };
    this.freezeEpoch++; // drop any leftover re-freeze pulses from a prior stop
  }

  /** Trip the gate so every linked token and cleanup loop exits ASAP. */
  private tripCancelGate(reason: string) {
    this.cancelGate.cancelled = true;
    this.cancelGate.reason = reason;
    this.runId++; // invalidate any in-flight runBuild catch/finally that would rewrite phase
  }

  /**
   * Keep freezing while the build runner is still stuck inside dig/pathNear.
   * Stops as soon as runnerActive clears or a new run arms the gate (freezeEpoch).
   */
  private scheduleReFreeze() {
    const epoch = ++this.freezeEpoch;
    const bot = this.instance.bot;
    for (const ms of [50, 120, 250, 500, 900, 1_500, 2_500, 4_000]) {
      setTimeout(() => {
        if (epoch !== this.freezeEpoch) return;
        if (!this.instance.bot || this.instance.bot !== bot) return;
        if (!this.cancelGate.cancelled) return;
        // Runner already exited — only the first couple of pulses still fire for residual pathfinder.
        if (!this.runnerActive && ms > 250) return;
        this.freezeBot();
      }, ms);
    }
  }

  /** Free body: cancel pathfinder-driving tasks that would re-grab the bot after build abort. */
  private freeBodyAfterAbort(reason: string) {
    this.freezeBot();
    try {
      this.instance.combat.pauseCompanionPathing(10_000, reason);
    } catch {
      /* combat optional during early boot */
    }
    // Cancel any pathing tasks still in the queue so Stop means the bot stands still.
    const pathTypes = new Set(["follow", "goto", "goto-player", "parkour-goto", "goto-waypoint"]);
    const cur = this.instance.tasks.currentSummary;
    if (cur && pathTypes.has(cur.type)) this.instance.tasks.cancel(cur.id, reason);
    for (const t of this.instance.tasks.queueSummaries) {
      if (pathTypes.has(t.type)) this.instance.tasks.cancel(t.id, reason);
    }
  }

  /**
   * Task token that also dies when stop/hardReset trips the service gate.
   * Used for pathNear / place / cleanup so panel abort is never ignored.
   */
  private linkToken(token: TaskToken): TaskToken {
    const gate = this.cancelGate;
    return {
      get cancelled() {
        return token.cancelled || gate.cancelled;
      },
      set cancelled(v: boolean) {
        token.cancelled = v;
      },
      get reason() {
        if (gate.cancelled) return gate.reason ?? token.reason;
        return token.reason;
      },
      set reason(v: string | undefined) {
        token.reason = v;
      }
    };
  }

  /** Cancel every build-related task currently queued or running. */
  private cancelBuildTasks(reason: string) {
    const buildTypes = new Set([
      "build",
      "build-acquire",
      "build-acquire-plan",
      "build-scan",
      "collect-build-materials"
    ]);
    const cur = this.instance.tasks.currentSummary;
    if (cur && buildTypes.has(cur.type)) this.instance.tasks.cancel(cur.id, reason);
    for (const t of this.instance.tasks.queueSummaries) {
      if (buildTypes.has(t.type)) this.instance.tasks.cancel(t.id, reason);
    }
  }

  private pushBlockEvent(ev: BuildPlacedBlock) {
    this.runtime.lastBlock = ev;
    this.runtime.recentBlocks = [...this.runtime.recentBlocks.slice(-15), ev];
  }

  // ---------------------------------------------------------------- materials

  private countHaveItem(itemNames: string[]): number {
    const bot = this.instance.bot;
    if (!bot) return 0;
    let n = 0;
    for (const it of bot.inventory.items()) {
      if (itemNames.includes(it.name)) n += it.count;
    }
    return n;
  }

  private hasItemForBlock(blockName: string): boolean {
    return this.countHaveItem(itemNameForBlock(blockName)) > 0;
  }

  /** Materials from a block list (preview / pre-build). */
  materialsFor(blocks: SchematicBlock[]): MaterialNeed[] {
    const needMap = materialCounts(blocks);
    return this.materialsFromNeedMap(needMap);
  }

  private materialsFromNeedMap(needMap: Record<string, number> | Map<string, number>): MaterialNeed[] {
    const bot = this.instance.bot;
    const creative = isCreativeMode(bot);
    const haveMap: Record<string, number> = {};
    if (bot) {
      for (const it of bot.inventory.items()) {
        haveMap[it.name] = (haveMap[it.name] ?? 0) + it.count;
      }
    }
    const entries = needMap instanceof Map ? [...needMap.entries()] : Object.entries(needMap);
    const out: MaterialNeed[] = [];
    for (const [name, need] of entries) {
      if (need <= 0) continue;
      const aliases = new Set([...itemNameForBlock(name), name]);
      let have = 0;
      for (const a of aliases) have += haveMap[a] ?? 0;
      const stored = creative ? 0 : this.stock.stockOf(aliases);
      const missing = creative ? 0 : Math.max(0, need - have - stored);
      out.push({ name, need, have, stored, missing });
    }
    return out.sort((a, b) => b.missing - a.missing || b.need - a.need || a.name.localeCompare(b.name));
  }

  private lastMaterialsAt = 0;

  /** Throttled ledger → materials refresh (per-block full recount was O(n²)). */
  private refreshMaterialsFromLedger(needLedger: Map<string, number>, force = false) {
    const now = Date.now();
    if (!force && now - this.lastMaterialsAt < 600) return;
    this.lastMaterialsAt = now;
    this.runtime.materials = this.materialsFromNeedMap(needLedger);
    this.emit(force);
  }

  private seedStockFromWorldMemory() {
    try {
      const rows = this.instance.getKnownChests?.() ?? [];
      this.stock.seed(rows, this.instance.runtime.dimension);
    } catch {
      /* seed is best-effort */
    }
  }

  // ---------------------------------------------------------------- public API

  async previewMaterials(schematicId: string, versionHint?: string, transform?: BuildTransform) {
    const parsed = await loadParsedSchematic(schematicId, versionHint, transform);
    this.seedStockFromWorldMemory();
    const blocks = parsed.blocks.filter((b) => !shouldSkipBlock(b.name, b.properties));
    return {
      meta: parsed.meta,
      materials: this.materialsFor(blocks),
      blockCount: blocks.length,
      size: { w: parsed.width, h: parsed.height, l: parsed.length },
      creative: isCreativeMode(this.instance.bot),
      storage: this.stock.toInfo(this.lastScanAt),
      transform: {
        rotateY: normalizeRotateY(transform?.rotateY),
        mirrorX: Boolean(transform?.mirrorX),
        mirrorZ: Boolean(transform?.mirrorZ)
      }
    };
  }

  /** Scan & mark nearby containers into the stock ledger (no withdrawing). */
  enqueueScanStorage(radius = 32) {
    return this.instance.tasks.enqueue(
      {
        type: "build-scan",
        label: `mark storage (r${radius})`,
        priority: PRIORITY.USER,
        params: { radius },
        requeueOnPreempt: true
      },
      () => async (token, report) => {
        this.seedStockFromWorldMemory();
        this.setActivity("Marking nearby storage…");
        report({ done: 0, total: 1, label: "storage scan" });
        const res = await scanNearbyStorage(
          this.instance,
          this.stock,
          { radius, maxContainers: 32, budgetMs: 120_000 },
          token,
          (label) => this.setActivity(label)
        );
        this.lastScanAt = Date.now();
        this.setActivity(null);
        this.runtime.label = `storage marked: ${res.scanned} containers`;
        this.emit(true);
        report({ done: 1, total: 1, label: `containers: ${res.scanned}` });
        this.log().success("Storage scan finished", `${res.scanned} containers indexed`);
      }
    );
  }

  /**
   * Queue the missing-material acquisition as its own task
   * (drops → storage ledger → craft chain → gather).
   */
  enqueueCollectMissing(opts: { schematicId: string; versionHint?: string; transform?: BuildTransform }) {
    const sid = opts.schematicId.trim();
    if (!sid) throw new Error("Schematic id required");
    const version = opts.versionHint || "1.20.4";

    return this.instance.tasks.enqueue(
      {
        type: "build-acquire",
        label: `missing materials: ${sid.slice(0, 8)}…`,
        priority: PRIORITY.USER,
        params: { schematicId: sid },
        requeueOnPreempt: true
      },
      () => async (token, report) => {
        if (isCreativeMode(this.instance.bot)) {
          this.setPhase("idle", "creative mode — materials not needed");
          report({ done: 1, total: 1, label: "creative" });
          return;
        }
        this.setActivity("Preparing material list…");
        this.setPhase("acquiring", "material list…");
        report({ done: 0, total: 1, label: "material list…" });
        const parsed = await loadParsedSchematic(sid, version, opts.transform);
        const blocks = parsed.blocks.filter((b) => !shouldSkipBlock(b.name, b.properties));
        const refresh = () => {
          this.runtime.materials = this.materialsFor(blocks);
          this.emit(true);
        };
        this.seedStockFromWorldMemory();
        refresh();

        // mark nearby storage so chest stock counts as available
        try {
          await scanNearbyStorage(
            this.instance,
            this.stock,
            { radius: 32, maxContainers: 24, budgetMs: 60_000 },
            token,
            (label) => this.setActivity(label)
          );
          this.lastScanAt = Date.now();
        } catch (e) {
          if (token.cancelled) throw e;
        }
        refresh();

        try {
          this.setActivity("Picking up dropped items…", null);
          report({ done: 0, total: 1, label: "drops…" });
          await this.instance.gather.runCollectDrops(undefined, 28, token, (p) => {
            report(p);
            this.setActivity(p.label ?? "Drops…", null);
            refresh();
          });
        } catch (e) {
          if (token.cancelled) throw e;
        }
        refresh();

        const missing = this.materialsFor(blocks).filter((m) => m.missing > 0);
        if (!missing.length) {
          this.setActivity(null, null);
          this.setPhase("idle", "no missing materials");
          report({ done: 1, total: 1, label: "nothing missing" });
          return;
        }

        let i = 0;
        for (const m of missing) {
          if (token.cancelled) throw new Error(token.reason ?? "cancelled");
          i++;
          this.setActivity(`Collecting: ${m.name} ×${m.missing} (${i}/${missing.length})`, m.name);
          report({ done: i - 1, total: missing.length, label: `collect ${m.name} ×${m.missing}` });
          try {
            await this.acquireOneMaterial(m.name, m.missing, token, report, refresh);
          } catch (e) {
            if (token.cancelled) throw e;
            this.log().warn(`Could not collect material: ${m.name}`, e instanceof Error ? e.message : String(e));
            this.setActivity(`Failed: ${m.name} — ${e instanceof Error ? e.message : String(e)}`, m.name);
          }
          refresh();
        }

        const still = this.materialsFor(blocks).filter((m) => m.missing > 0);
        refresh();
        this.setActivity(null, null);
        const label =
          still.length === 0
            ? "materials complete"
            : `partial: still missing ${still
                .slice(0, 4)
                .map((m) => `${m.name}×${m.missing}`)
                .join(", ")}`;
        this.setPhase(still.length === 0 ? "idle" : "failed", label, still.length ? label : undefined);
        report({ done: missing.length, total: missing.length, label });
        this.log().info("Missing-material collection finished", label);
      }
    );
  }

  /**
   * Abort in-flight build immediately. Does NOT start scaffold cleanup —
   * background dig/path was leaving the bot stuck after Stop / Reset work.
   * Scaffolds are abandoned (cleared from the ledger); user can dig manually.
   */
  stopBuild(reason = "build stopped") {
    this.tripCancelGate(reason);
    this.cancelBuildTasks(reason);
    this.session = null;
    this.runtime.resumePending = false;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    // abandon temporary-block ledger without walking/digging (keeps bot free)
    if (this.scaffolds.count) {
      this.runtime.scaffoldsLeft += this.scaffolds.count;
      this.log().info("Build stop — scaffolds abandoned (no dig)", `${this.scaffolds.count} left in world`);
    }
    this.scaffolds.clear();
    this.freeBodyAfterAbort(reason);
    this.scheduleReFreeze();

    this.runtime.phase = this.runtime.phase === "idle" ? "idle" : "cancelled";
    this.runtime.label = reason;
    this.runtime.error = reason;
    this.runtime.activity = null;
    this.runtime.activityMaterial = null;
    this.runtime.stuck = null;
    this.emit(true);
    this.log().info("Build stopped", reason);
  }

  /** Reset everything: build runtime + scaffolds (bot stays connected and free). */
  hardReset(reason = "build reset") {
    this.tripCancelGate(reason);
    this.cancelBuildTasks(reason);
    this.session = null;
    this.runtime.resumePending = false;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.scaffolds = new ScaffoldTracker();
    this.freeBodyAfterAbort(reason);
    this.scheduleReFreeze();
    this.runtime = emptyBuildRuntime();
    this.runtime.label = reason;
    this.emit(true);
    this.log().info("Build hard-reset", reason);
  }

  /** Bot lost connection: freeze state and (optionally) resume on spawn. */
  onDisconnect() {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (!this.session?.resumeOnReconnect) return;
    if (!ACTIVE_PHASES.has(this.runtime.phase)) return;
    this.runtime.resumePending = true;
    this.setPhase("paused", "connection lost — will resume after respawn");
    this.log().warn("Build paused", "disconnected mid-build; auto-resume is armed");
  }

  /** Bot (re)spawned: resume a paused build (placement skips finished blocks). */
  onSpawn() {
    if (!this.runtime.resumePending || !this.session) return;
    const session = this.session;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (!this.runtime.resumePending || this.session !== session) return;
      if (!this.instance.bot || this.instance.status !== "online") return;
      this.runtime.resumePending = false;
      this.log().info("Resuming build after reconnect", session.schematicId.slice(0, 8));
      try {
        this.enqueueBuild({
          ...session.opts,
          schematicId: session.schematicId,
          origin: { mode: "coords", x: session.origin.x, y: session.origin.y, z: session.origin.z }
        });
      } catch (e) {
        this.log().error("Build resume failed", e instanceof Error ? e.message : String(e));
      }
    }, 2_500);
  }

  enqueueBuild(opts: BuildOpts) {
    const sid = opts.schematicId.trim();
    if (!sid) throw new Error("Schematic id required");

    this.stopBuild("starting new build");
    this.scaffolds = new ScaffoldTracker();
    this.runtime = emptyBuildRuntime();
    this.session = null; // fresh session created when the task starts running
    this.runtime.phase = "preparing";
    this.runtime.schematicId = sid;
    this.runtime.startedAt = Date.now();
    this.runtime.label = "preparing…";
    this.runtime.collectMissing = Boolean(opts.collectMissing);
    this.runtime.placeOrder = normalizePlaceOrder(opts.placeOrder);
    this.runtime.transform = {
      rotateY: normalizeRotateY(opts.rotateY),
      mirrorX: Boolean(opts.mirrorX),
      mirrorZ: Boolean(opts.mirrorZ)
    };
    this.emit();

    return this.instance.tasks.enqueue(
      {
        type: "build",
        label: `build: ${sid.slice(0, 8)}…`,
        priority: PRIORITY.USER,
        params: { ...opts },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runBuild({ ...opts, schematicId: sid }, token, report)
    );
  }

  detach() {
    // connection teardown — keep the session so a reconnect can resume
    this.onDisconnect();
    if (!this.runtime.resumePending) {
      this.stopBuild("bot disconnected");
      this.scaffolds.clear();
      this.runtime = emptyBuildRuntime();
    }
    this.emit();
  }

  // ---------------------------------------------------------------- origin & acquire

  private resolveOrigin(origin: BuildOrigin): { x: number; y: number; z: number } {
    const bot = this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot offline");

    if (origin.mode === "here") {
      return {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z)
      };
    }
    if (origin.mode === "player") {
      const name = String(origin.player ?? "").trim();
      if (!name) throw new Error("Player name required");
      const ent = bot.players[name]?.entity;
      if (!ent) {
        const inTab = Boolean(bot.players[name]);
        throw new Error(
          inTab ? `${name} out of range — position unknown (get closer)` : `${name} not visible on server`
        );
      }
      return {
        x: Math.floor(ent.position.x),
        y: Math.floor(ent.position.y),
        z: Math.floor(ent.position.z)
      };
    }
    if (origin.x == null || origin.y == null || origin.z == null) {
      throw new Error("x,y,z required for coordinate origin");
    }
    return {
      x: Math.floor(Number(origin.x)),
      y: Math.floor(Number(origin.y)),
      z: Math.floor(Number(origin.z))
    };
  }

  /**
   * Acquire one material: drops → stock ledger fetch → craft chain → gather → craft retry.
   * `count` is ADDED to what the inventory already holds.
   */
  private async acquireOneMaterial(
    blockName: string,
    count: number,
    token: TaskToken,
    report: ProgressFn,
    refreshUI: () => void
  ) {
    const names = itemNameForBlock(blockName);
    const item = names[0] ?? blockName;
    const additional = Math.max(1, Math.floor(count));
    const targetHave = this.countHaveItem(names) + additional;
    const refresh = (label: string) => {
      this.runtime.activity = label;
      this.runtime.activityMaterial = blockName;
      this.runtime.label = label;
      refreshUI();
      report({ done: Math.min(this.countHaveItem(names), targetHave), total: targetHave, label });
    };

    // 1) dropped items nearby
    try {
      refresh(`Searching ground: ${item}`);
      await runSmartCollectDrops(this.instance, item, 16, token, (p) => refresh(p.label ?? `Ground: ${item}`), 20_000);
    } catch (e) {
      if (token.cancelled) throw e;
    }
    if (this.countHaveItem(names) >= targetHave) return;

    // 2) marked storage (ledger) — withdraw only what is needed
    const storageNeed = targetHave - this.countHaveItem(names);
    if (this.stock.stockOf(names) > 0) {
      if (this.instance.bot && this.instance.bot.inventory.emptySlotCount() < 2) {
        await makeInventoryRoom(this.instance, this.stock, new Set(names), 3, token, (label) => refresh(label));
      }
      await fetchFromStorage(this.instance, this.stock, names, storageNeed, token, (label) => refresh(label));
    } else {
      await withdrawBuildMaterials(this.instance, names, storageNeed, token, (label) => refresh(label));
    }
    if (this.countHaveItem(names) >= targetHave) return;

    // 3) craft chain (e.g. dark_oak_fence → planks → log)
    if (this.instance.craft.canCraft(item)) {
      try {
        refresh(`Craft chain: ${item} · target ${targetHave}`);
        await this.instance.craft.runCraftInline(item, targetHave, token, (p) => refresh(p.label ?? `Craft: ${item}`));
      } catch (error) {
        if (token.cancelled) throw error;
        this.log().warn(`Craft chain incomplete: ${item}`, error instanceof Error ? error.message : String(error));
      }
    }
    if (this.countHaveItem(names) >= targetHave) return;

    // 4) last resort: gather the named resource in the world — with a hard time
    // budget so one unfindable material cannot stall the whole build for ~6+ min
    refresh(`Searching resource: ${item} · target ${targetHave}`);
    const scoped = budgetToken(token, MATERIAL_GATHER_BUDGET_MS, `${item}: search budget exceeded`);
    try {
      await this.instance.gather.runCollectBlock(item, targetHave, scoped, (p) => refresh(p.label ?? `Collecting: ${item}`));
    } catch (e) {
      if (token.cancelled) throw e;
      this.log().warn(`Gather step ended: ${item}`, e instanceof Error ? e.message : String(e));
    }

    // raw inputs may have arrived — craft once more
    if (this.countHaveItem(names) < targetHave && this.instance.craft.canCraft(item)) {
      await this.instance.craft.runCraftInline(item, targetHave, token, (p) => refresh(p.label ?? `Craft: ${item}`));
    }
    refreshUI();
    if (this.countHaveItem(names) < targetHave) {
      throw new Error(`${item}: target ${targetHave}, found ${this.countHaveItem(names)}`);
    }
  }

  // ---------------------------------------------------------------- build run

  private async runBuild(opts: BuildOpts, rawToken: TaskToken, report: ProgressFn) {
    // New run may follow a stop/reset — clear the abort gate so work can proceed.
    this.armCancelGate();
    const myRun = ++this.runId;
    // Linked token: TaskQueue cancel OR panel stop/hardReset (cancelGate) both abort.
    const token = this.linkToken(rawToken);
    this.runnerActive = true;

    const version = opts.versionHint || "1.20.4";
    const placeOrder = normalizePlaceOrder(opts.placeOrder);
    const transform: BuildTransform = {
      rotateY: normalizeRotateY(opts.rotateY),
      mirrorX: Boolean(opts.mirrorX),
      mirrorZ: Boolean(opts.mirrorZ)
    };
    this.runtime.transform = {
      rotateY: transform.rotateY ?? 0,
      mirrorX: Boolean(transform.mirrorX),
      mirrorZ: Boolean(transform.mirrorZ)
    };
    this.runtime.placeOrder = placeOrder;
    this.runtime.collectMissing = Boolean(opts.collectMissing);
    this.runtime.resumePending = false;

    try {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      this.setPhase("preparing", "loading schematic…");
      const parsed = await loadParsedSchematic(opts.schematicId, version, transform);
      this.runtime.schematicName = parsed.meta.name;
      const blocks = orderBlocksPrinter(parsed.blocks.filter((b) => !shouldSkipBlock(b.name, b.properties)));

      // Origin FIRST — the old code resolved it AFTER material gathering, so a
      // "here" build started wherever the gather walk ended, not where the user stood.
      // A preempt/resume rerun reuses the session origin instead of re-resolving.
      const sameSession =
        this.session &&
        this.session.schematicId === opts.schematicId &&
        this.session.opts.placeOrder === opts.placeOrder;
      const origin = sameSession ? this.session!.origin : this.resolveOrigin(opts.origin);
      this.runtime.origin = origin;
      this.session = {
        schematicId: opts.schematicId,
        origin,
        opts: { ...opts },
        resumeOnReconnect: opts.resumeOnReconnect !== false,
        startedAt: this.session?.startedAt ?? Date.now()
      };

      const creative = isCreativeMode(this.instance.bot);
      this.runtime.creative = creative;

      const jobs: BuildJob[] = blocks.map((block, i) => ({
        block,
        name: block.name,
        wx: origin.x + block.dx,
        wy: origin.y + block.dy,
        wz: origin.z + block.dz,
        ord: i,
        done: false,
        attempts: 0,
        retryAt: 0,
        unreachable: 0,
        reopened: false
      }));
      const board = new JobBoard(jobs);
      this.runtime.total = jobs.length;

      // incremental need ledger (per-block full recount was O(n²) on big schematics)
      const needLedger = new Map<string, number>();
      for (const j of jobs) needLedger.set(j.name, (needLedger.get(j.name) ?? 0) + 1);

      this.seedStockFromWorldMemory();
      this.refreshMaterialsFromLedger(needLedger, true);

      const ctx: LoopCtx = {
        token,
        report,
        board,
        needLedger,
        creative,
        allowPartial: Boolean(opts.allowPartial),
        collectMissing: Boolean(opts.collectMissing),
        placeOrder,
        schematicName: parsed.meta.name
      };

      if (!creative) {
        // mark nearby storage so chest stock counts as available material
        this.setPhase("acquiring", "marking nearby storage…");
        try {
          await scanNearbyStorage(
            this.instance,
            this.stock,
            { radius: 32, maxContainers: 24, budgetMs: 60_000 },
            token,
            (label) => this.setActivity(label)
          );
          this.lastScanAt = Date.now();
        } catch (e) {
          if (token.cancelled) throw e;
        }
        this.refreshMaterialsFromLedger(needLedger, true);

        if (opts.collectMissing) {
          await this.preBuildAcquire(ctx);
        }

        const missing = this.materialsFromNeedMap(needLedger).filter((m) => m.missing > 0);
        if (missing.length && !opts.allowPartial) {
          const msg = `Missing materials: ${missing
            .slice(0, 5)
            .map((m) => `${m.name}×${m.missing}`)
            .join(", ")}${missing.length > 5 ? "…" : ""}`;
          this.setPhase("failed", msg, msg);
          this.log().warn("Build did not start — missing materials", msg);
          throw new Error(msg + " (enable partial build or collect materials)");
        }
      }

      const rotLabel =
        transform.rotateY || transform.mirrorX || transform.mirrorZ
          ? ` · R${transform.rotateY ?? 0}${transform.mirrorX ? " mX" : ""}${transform.mirrorZ ? " mZ" : ""}`
          : "";
      this.setActivity(`Building: ${parsed.meta.name}`, null);
      this.setPhase("building", `build: ${parsed.meta.name}${rotLabel}`);
      this.log().info(
        `Build started: ${parsed.meta.name}`,
        `origin ${origin.x},${origin.y},${origin.z} · ${jobs.length} blocks · mode=${placeOrder}${creative ? " · creative" : ""}${rotLabel}`
      );

      // ---- main placement loop ----
      await this.placementLoop(ctx);

      // ---- final verify & repair (the build may have been damaged meanwhile) ----
      this.setPhase("verifying", "verifying structure…");
      for (let pass = 0; pass < 2; pass++) {
        const reopened = this.verifyAll(ctx);
        if (!reopened) break;
        this.log().warn("Verify found damage", `${reopened} block(s) re-queued (pass ${pass + 1})`);
        this.setPhase("building", `repairing: ${reopened} blocks`);
        await this.placementLoop(ctx);
        this.setPhase("verifying", "re-verifying…");
      }

      try {
        this.instance.bot?.pathfinder?.setGoal(null);
      } catch {
        /* */
      }

      // ---- scaffold cleanup (honest accounting) ----
      this.flushEmit();
      this.setPhase("cleanup", "removing temporary blocks…");
      this.log().info("Scaffold cleanup", `${this.scaffolds.count} entries`);
      const cleanupRes = await cleanupScaffolds(this.instance, this.scaffolds, token, {
        onProgress: (cleared, left, total) => {
          this.runtime.scaffoldsCleared = cleared;
          this.runtime.scaffoldsLeft = left;
          this.runtime.label = `cleanup ${cleared}/${total}${left ? ` · ${left} stuck` : ""}`;
          report({ done: jobs.length, total: jobs.length, label: `scaffold ${cleared}/${total}` });
          this.emit();
        },
        onDigged: async () => {
          try {
            await runSmartCollectDrops(this.instance, undefined, 8, token, () => {}, 6_000);
          } catch {
            /* vacuum is best-effort */
          }
        }
      });
      this.runtime.scaffoldsCleared = cleanupRes.cleared;
      this.runtime.scaffoldsLeft = cleanupRes.left;

      if (token.cancelled) {
        this.setPhase("cancelled", "cancelled");
        throw new Error(token.reason ?? "cancelled");
      }

      const placed = this.runtime.placed;
      const skipped = this.runtime.skipped;
      const failed = this.runtime.failed;
      const label = `done: ${placed} placed, ${skipped} existing, ${failed} failed${
        this.runtime.repaired ? `, ${this.runtime.repaired} repaired` : ""
      }${this.runtime.fixedWrong ? `, ${this.runtime.fixedWrong} corrected` : ""}, scaffold ${cleanupRes.cleared}${
        cleanupRes.left ? ` (+${cleanupRes.left} left)` : ""
      }`;
      this.runtime.materials = this.materialsFromNeedMap(ctx.needLedger);
      this.emit(true);
      this.setActivity(null, null);
      this.session = null;
      if (failed === 0) {
        this.setPhase("done", label);
        this.log().success(`Build complete: ${parsed.meta.name}`, label);
        report({ done: jobs.length, total: jobs.length, label });
      } else {
        this.setPhase("failed", label, `${failed} block(s) could not be placed`);
        this.log().warn(`Build partial/failed: ${parsed.meta.name}`, label);
        report({ done: jobs.length, total: jobs.length, label });
        throw new Error(label);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Superseded by stop/reset or a newer build — do not rewrite UI / session.
      if (myRun !== this.runId) {
        this.log().info("Build run superseded", msg);
        throw e;
      }

      const offline = !this.instance.bot || this.instance.status !== "online";
      if (offline && this.session?.resumeOnReconnect) {
        // disconnected mid-build — keep session, onDisconnect/onSpawn handle resume
        this.runtime.resumePending = true;
        this.setPhase("paused", "connection lost — will resume after respawn");
        throw e;
      }
      // preempted by a higher-priority task (eat/defense) or paused: the queue
      // reruns this build — keep scaffolds & session so it continues in place
      const reasonStr = String(token.reason ?? rawToken.reason ?? "");
      const preempted =
        (token.cancelled || rawToken.cancelled) &&
        /higher-priority|paused/i.test(reasonStr) &&
        !/reset|stopped|panel|all cancelled|all work|starting new/i.test(reasonStr);
      if (preempted) {
        this.runtime.label = "paused — a higher-priority task is running";
        this.emit(true);
        this.log().info("Build preempted", reasonStr);
        throw e;
      }

      // Abort / fail path: free the bot NOW. Never start uncancelable scaffold dig
      // (that was leaving pathfinder stuck after Stop / Reset work).
      this.session = null;
      this.runtime.resumePending = false;
      if (this.scaffolds.count) {
        this.runtime.scaffoldsLeft += this.scaffolds.count;
        this.scaffolds.clear();
      }
      this.freezeBot();
      this.runtime.stuck = null;
      this.runtime.activity = null;
      this.runtime.activityMaterial = null;

      if (this.runtime.phase !== "failed" && this.runtime.phase !== "cancelled") {
        this.setPhase(token.cancelled || this.cancelGate.cancelled ? "cancelled" : "failed", msg, msg);
      } else {
        this.emit(true);
      }
      this.log().error("Build error/cancelled", msg);
      throw e;
    } finally {
      this.runnerActive = false;
      // If user aborted, one last freeze so residual dig/path cannot leave the bot walking.
      if (this.cancelGate.cancelled || rawToken.cancelled) {
        this.freezeBot();
      }
    }
  }

  // ---------------------------------------------------------------- placement loop

  private async placementLoop(ctx: LoopCtx): Promise<void> {
    const { token, report, board, needLedger, creative, placeOrder } = ctx;
    const instance = this.instance;

    /** cells confirmed solid by us (support scoring without world reads) */
    const solidKeys = new Set<string>();
    const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
    for (const j of board.all) {
      if (j.done && (j.status === "placed" || j.status === "skipped")) solidKeys.add(keyOf(j.wx, j.wy, j.wz));
    }

    const worldSolid = (x: number, y: number, z: number): boolean => {
      if (solidKeys.has(keyOf(x, y, z))) return true;
      const bot = instance.bot;
      if (!bot) return false;
      const b = bot.blockAt(v3(x, y, z));
      if (!b) return false;
      return !isReplaceableBlock(b.name);
    };
    const hasSupport = (job: BuildJob): boolean => worldSolid(job.wx, job.wy - 1, job.wz);

    let stickyJob: BuildJob | null = null;
    const missingNames = new Set<string>();
    const conjureFails = new Map<string, number>();
    let acquirePasses = 0;
    let acquireStalls = 0;

    const watchdog = {
      lastProgressAt: Date.now(),
      stalls: 0,
      openAtFirstStall: -1
    };
    let lastRepairAt = Date.now();
    let lastWalkTick = 0;

    const noteProgress = () => {
      watchdog.lastProgressAt = Date.now();
      watchdog.stalls = 0;
      watchdog.openAtFirstStall = -1;
      if (this.runtime.stuck) {
        this.runtime.stuck = null;
        this.emit();
      }
    };

    const hasItemFor = (name: string): boolean => (creative ? true : this.hasItemForBlock(name));

    const markDone = (job: BuildJob, res: "placed" | "skipped" | "failed") => {
      if (job.done) return;
      board.complete(job, res);
      needLedger.set(job.name, Math.max(0, (needLedger.get(job.name) ?? 1) - 1));
      let evStatus: BuildPlacedBlock["status"] = res;
      if (res === "placed") {
        this.runtime.placed++;
        solidKeys.add(keyOf(job.wx, job.wy, job.wz));
        this.scaffolds.protectStructure(job.wx, job.wy, job.wz);
        if (job.reopened) {
          this.runtime.repaired++;
          evStatus = "repaired";
        }
        noteProgress();
      } else if (res === "skipped") {
        this.runtime.skipped++;
        solidKeys.add(keyOf(job.wx, job.wy, job.wz));
        noteProgress();
      } else {
        this.runtime.failed++;
      }
      if (stickyJob === job) stickyJob = null;
      this.pushBlockEvent({ name: job.name, x: job.wx, y: job.wy, z: job.wz, status: evStatus, t: Date.now() });
      this.runtime.scaffoldsPlaced = this.scaffolds.count;
      const doneN = this.runtime.placed + this.runtime.skipped + this.runtime.failed;
      const act =
        res === "placed"
          ? job.reopened
            ? `Repaired: ${job.name}`
            : `Placed: ${job.name}`
          : res === "skipped"
            ? `Already correct: ${job.name}`
            : `Failed permanently: ${job.name}`;
      this.runtime.activity = `${act} · ${doneN}/${board.all.length}`;
      this.runtime.activityMaterial = job.name;
      this.runtime.label = `${job.name} @${job.wx},${job.wy},${job.wz} · ${doneN}/${board.all.length} · +${this.runtime.placed}`;
      this.refreshMaterialsFromLedger(needLedger);
      report({ done: doneN, total: board.all.length, label: this.runtime.label });
      this.emit();
    };

    const onFixedWrongBlock = () => {
      this.runtime.fixedWrong++;
      // vacuum the drops of the broken wrong block soon (throttled by caller loop)
      pendingFixSweep = true;
    };
    let pendingFixSweep = false;

    const processPlacement = (job: BuildJob, res: "placed" | "skipped" | "failed" | "outofreach" | "noitem") => {
      if (res === "placed" || res === "skipped") {
        markDone(job, res);
        return;
      }
      if (res === "noitem") {
        missingNames.add(job.name);
        job.retryAt = Date.now() + 4_000;
        return;
      }
      if (res === "outofreach") return; // walking handles it
      job.attempts++;
      if (job.attempts >= 5) {
        markDone(job, "failed");
        return;
      }
      job.retryAt = Date.now() + 300 + job.attempts * 260;
      this.runtime.activity = `Will retry: ${job.name} (${job.attempts}/5)`;
      this.runtime.activityMaterial = job.name;
      this.emit();
    };

    /** Place all open jobs already within reach (spatial query, item-grouped). */
    const placeCluster = async (optsPlace?: { stopFirst?: boolean; maxCluster?: number }): Promise<number> => {
      const bot = instance.bot;
      if (!bot?.entity) return 0;
      const stopFirst = optsPlace?.stopFirst !== false;
      const maxCluster = optsPlace?.maxCluster ?? 14;
      const now = Date.now();
      const p = bot.entity.position;
      const cands = board
        .nearbyOpen(p.x, p.y + 0.9, p.z, PLACE_REACH + 0.4)
        .filter((job) => job.retryAt <= now && hasItemFor(job.name));
      if (!cands.length) return 0;
      // group by item so equips batch; lower first for support
      cands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.wy - b.wy));
      if (stopFirst) {
        try {
          bot.pathfinder?.setGoal(null);
          bot.clearControlStates();
        } catch {
          /* */
        }
        await sleep(50);
      }
      let processed = 0;
      for (const job of cands) {
        if (processed >= maxCluster) break;
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        if (job.done) continue;
        if (distToBlock(instance, job.wx, job.wy, job.wz) > PLACE_REACH) continue;
        if (creative && !this.hasItemForBlock(job.name)) {
          await this.conjureFor(job, conjureFails, markDone, board);
          if (!this.hasItemForBlock(job.name)) continue;
        }
        const res = await placeBlockAt(instance, job.wx, job.wy, job.wz, job.name, token, this.scaffolds, {
          retries: 1,
          skipPath: true,
          softSettle: !stopFirst,
          props: job.block.properties,
          onFixedWrongBlock
        });
        processPlacement(job, res);
        if (res === "placed" || res === "skipped") processed++;
      }
      return processed;
    };

    /** Choose the next target according to the placement mode. */
    const pickNext = (): BuildJob | null => {
      const bot = instance.bot;
      if (!bot?.entity) return null;
      const now = Date.now();
      const p = bot.entity.position;
      const accept = (job: BuildJob) => job.retryAt <= now && hasItemFor(job.name);

      if (stickyJob && board.isOpen(stickyJob) && accept(stickyJob)) return stickyJob;

      if (placeOrder === "printer") {
        // strict floor-first; look a few layers ahead when the floor is blocked
        for (const y of board.openLayersFrom(4)) {
          const ready = board.openInLayer(y).filter(accept);
          if (!ready.length) continue;
          let best: BuildJob | null = null;
          let bestScore = Infinity;
          for (const job of ready) {
            const d = Math.hypot(job.wx + 0.5 - p.x, job.wy + 0.5 - p.y, job.wz + 0.5 - p.z);
            const supportPen = hasSupport(job) ? 0 : 60_000;
            const score = supportPen + job.ord * 10 + d * 2;
            if (score < bestScore) {
              bestScore = score;
              best = job;
            }
          }
          if (best) {
            stickyJob = best;
            return best;
          }
        }
        return null;
      }

      // nearby-first: nearest placeable, support preferred
      const withSupport = board.nearestOpen(p.x, p.y, p.z, (j) => accept(j) && hasSupport(j));
      const chosen = withSupport ?? board.nearestOpen(p.x, p.y, p.z, accept);
      if (chosen) stickyJob = chosen;
      return chosen;
    };

    /** Rolling verify of completed cells near the bot — repairs mid-build damage. */
    let repairCursor = 0;
    const repairTick = (force = false) => {
      const bot = instance.bot;
      if (!bot?.entity) return 0;
      const now = Date.now();
      if (!force && now - lastRepairAt < REPAIR_TICK_MS) return 0;
      lastRepairAt = now;
      const p = bot.entity.position;
      let checked = 0;
      let reopened = 0;
      const total = board.all.length;
      for (let i = 0; i < total && checked < 40; i++) {
        repairCursor = (repairCursor + 1) % total;
        const job = board.all[repairCursor]!;
        if (!job.done || job.status === "failed") continue;
        const d = Math.hypot(job.wx + 0.5 - p.x, job.wy + 0.5 - p.y, job.wz + 0.5 - p.z);
        if (d > 28) continue;
        checked++;
        const b = bot.blockAt(v3(job.wx, job.wy, job.wz));
        if (!b) continue; // chunk not loaded
        const itemNames = itemNameForBlock(job.name);
        const ok = namesMatch(b.name, job.name) || itemNames.some((n) => namesMatch(b.name, n));
        if (!ok) {
          board.reopen(job);
          needLedger.set(job.name, (needLedger.get(job.name) ?? 0) + 1);
          if (job.status === "placed") this.runtime.placed = Math.max(0, this.runtime.placed - 1);
          else if (job.status === "skipped") this.runtime.skipped = Math.max(0, this.runtime.skipped - 1);
          solidKeys.delete(keyOf(job.wx, job.wy, job.wz));
          reopened++;
        }
      }
      if (reopened > 0) {
        this.runtime.activity = `Damage detected — repairing ${reopened} block(s)`;
        this.refreshMaterialsFromLedger(needLedger, true);
        this.log().warn("Build damage detected", `${reopened} block(s) re-queued`);
      }
      return reopened;
    };

    /** Stall watchdog: recovery ladder instead of a blind round cap. */
    const watchdogTick = async () => {
      const now = Date.now();
      if (now - watchdog.lastProgressAt < STALL_MS) return;
      watchdog.lastProgressAt = now; // new window per recovery step
      watchdog.stalls++;
      if (watchdog.openAtFirstStall < 0) watchdog.openAtFirstStall = board.openCount;
      this.runtime.stuck = `stall ${watchdog.stalls}: recovery running`;
      this.setActivity(`No progress — recovery attempt ${watchdog.stalls}`, null);
      this.log().warn("Build watchdog", `no progress for ${STALL_MS / 1000}s (recovery ${watchdog.stalls})`);

      const bot = instance.bot;
      try {
        bot?.pathfinder?.setGoal(null);
        bot?.clearControlStates();
      } catch {
        /* */
      }
      stickyJob = null;

      if (watchdog.stalls === 1) {
        // give every deferred job a fresh chance + small jiggle walk
        const open = board.openJobs();
        for (const j of open) j.retryAt = 0;
        if (bot?.entity && this.runtime.origin) {
          const o = this.runtime.origin;
          try {
            await pathNear(instance, o.x + 0.5, o.y, o.z + 0.5, 6, token, { clearGoal: true, timeoutMs: 6_000 });
          } catch {
            /* */
          }
        }
      } else if (watchdog.stalls === 2) {
        repairTick(true);
        try {
          await runSmartCollectDrops(instance, undefined, 12, token, () => {}, 8_000);
        } catch {
          /* */
        }
      } else if (watchdog.stalls === 3) {
        // drop the poison target: nearest open job that kept failing
        const bot2 = instance.bot;
        if (bot2?.entity) {
          const p = bot2.entity.position;
          const stuckJob =
            board.nearestOpen(p.x, p.y, p.z, (j) => j.attempts >= 2 || j.unreachable >= 2) ??
            board.nearestOpen(p.x, p.y, p.z, () => true);
          if (stuckJob) {
            this.log().warn("Watchdog dropped a stuck target", `${stuckJob.name} @${stuckJob.wx},${stuckJob.wy},${stuckJob.wz}`);
            markDone(stuckJob, "failed");
          }
        }
      } else {
        if (board.openCount < watchdog.openAtFirstStall) {
          // some progress across recoveries — keep going, reset ladder
          watchdog.stalls = 0;
          watchdog.openAtFirstStall = -1;
        } else {
          throw new Error(
            `Build stuck: no progress after ${watchdog.stalls} recovery attempts (${board.openCount} blocks open)`
          );
        }
      }
      this.emit(true);
    };

    // ---------------- loop ----------------
    // hard safety cap only as a last resort — the watchdog is the real guard
    let guard = 0;
    const guardMax = board.all.length * 40 + 4_000;

    while (board.openCount > 0 && guard < guardMax) {
      guard++;
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");

      await placeCluster({ stopFirst: true, maxCluster: 12 });
      if (board.openCount === 0) break;

      if (pendingFixSweep) {
        pendingFixSweep = false;
        try {
          await runSmartCollectDrops(instance, undefined, 7, token, () => {}, 5_000);
        } catch {
          /* */
        }
      }

      const next = pickNext();

      if (!next) {
        // nothing placeable right now: deferred timers or missing items
        const open = board.openJobs();
        const now = Date.now();
        const withItems = open.filter((j) => hasItemFor(j.name));
        if (withItems.length) {
          const soonest = Math.min(...withItems.map((j) => j.retryAt));
          await sleep(Math.max(60, Math.min(500, soonest - now)));
          await watchdogTick();
          continue;
        }

        if (creative) {
          // conjure the most needed material and go on
          const counts = new Map<string, number>();
          for (const j of open) counts.set(j.name, (counts.get(j.name) ?? 0) + 1);
          const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
          if (top) {
            const sample = open.find((j) => j.name === top)!;
            await this.conjureFor(sample, conjureFails, markDone, board);
          }
          await watchdogTick();
          continue;
        }

        // survival: mid-build acquisition (ledger fetch → collect chain)
        acquirePasses++;
        const gained = await this.midBuildAcquire(ctx, missingNames, acquirePasses);
        if (gained > 0) {
          acquireStalls = 0;
          noteProgress();
          continue;
        }
        acquireStalls++;
        if (acquireStalls < 2 && ctx.collectMissing && acquirePasses < 8) {
          continue;
        }

        // nothing acquirable anymore
        if (ctx.allowPartial) {
          let dropped = 0;
          for (const j of open) {
            if (!hasItemFor(j.name)) {
              markDone(j, "failed");
              dropped++;
            }
          }
          this.log().warn("Partial build: material exhausted", `${dropped} block(s) skipped as failed`);
          if (board.openCount === 0) break;
          continue;
        }
        const missing = this.materialsFromNeedMap(needLedger)
          .filter((m) => m.missing > 0)
          .slice(0, 5)
          .map((m) => `${m.name}×${m.missing}`)
          .join(", ");
        throw new Error(`Materials exhausted: ${missing || "unknown"} (enable partial build or collect materials)`);
      }

      // make sure we hold the item (fetch just-in-time from marked storage)
      if (!creative && !this.hasItemForBlock(next.name)) {
        const ok = await this.ensureItemFor(ctx, next);
        if (!ok) {
          missingNames.add(next.name);
          next.retryAt = Date.now() + 5_000;
          stickyJob = null;
        }
        await watchdogTick();
        continue;
      }
      if (creative && !this.hasItemForBlock(next.name)) {
        await this.conjureFor(next, conjureFails, markDone, board);
        if (!this.hasItemForBlock(next.name)) {
          await watchdogTick();
          continue;
        }
      }

      const dist = distToBlock(instance, next.wx, next.wy, next.wz);
      this.runtime.label = `walk → ${next.wx},${next.wy},${next.wz} · open ${board.openCount}`;
      this.runtime.activity =
        dist > PLACE_REACH
          ? `Walking: ${next.name} (${dist.toFixed(1)}m) @${next.wx},${next.wy},${next.wz}`
          : `Placing: ${next.name} @${next.wx},${next.wy},${next.wz}`;
      this.runtime.activityMaterial = next.name;
      report({
        done: this.runtime.placed + this.runtime.skipped + this.runtime.failed,
        total: board.all.length,
        label: this.runtime.label
      });
      this.emit();

      // walk when far — placing softly whatever comes into reach en route
      if (dist > PLACE_REACH) {
        await pathNear(instance, next.wx + 0.5, next.wy, next.wz + 0.5, 2.6, token, {
          clearGoal: true,
          timeoutMs: 14_000,
          onTick: async () => {
            const t = Date.now();
            if (t - lastWalkTick < 280) return;
            lastWalkTick = t;
            await placeCluster({ stopFirst: false, maxCluster: 3 });
          }
        });
      }

      // the en-route cluster may have finished it already
      if (!next.done && board.isOpen(next)) {
        const res = await placeBlockAt(instance, next.wx, next.wy, next.wz, next.name, token, this.scaffolds, {
          retries: 3,
          skipPath: false,
          props: next.block.properties,
          onFixedWrongBlock
        });
        if (res === "outofreach") {
          next.unreachable++;
          if (next.unreachable >= 6) {
            markDone(next, "failed");
          } else {
            next.retryAt = Date.now() + 500 + next.unreachable * 300;
            this.runtime.activity = `Unreachable, will re-path: ${next.name} (${next.unreachable}/6)`;
            this.emit();
            stickyJob = null;
          }
        } else {
          processPlacement(next, res);
        }
      }

      await placeCluster({ stopFirst: true, maxCluster: 16 });
      repairTick();
      await watchdogTick();
    }

    if (guard >= guardMax && board.openCount > 0) {
      throw new Error(`Build aborted by safety cap (${board.openCount} blocks open)`);
    }
  }

  /** Full-structure verification: re-queue every damaged/missing completed cell. */
  private verifyAll(ctx: LoopCtx): number {
    const bot = this.instance.bot;
    if (!bot) return 0;
    let reopened = 0;
    for (const job of ctx.board.all) {
      if (!job.done || job.status === "failed") continue;
      const b = bot.blockAt(v3(job.wx, job.wy, job.wz));
      if (!b) continue; // chunk not loaded — was confirmed at placement time
      const itemNames = itemNameForBlock(job.name);
      const ok = namesMatch(b.name, job.name) || itemNames.some((n) => namesMatch(b.name, n));
      if (!ok) {
        ctx.board.reopen(job);
        ctx.needLedger.set(job.name, (ctx.needLedger.get(job.name) ?? 0) + 1);
        if (job.status === "placed") this.runtime.placed = Math.max(0, this.runtime.placed - 1);
        else if (job.status === "skipped") this.runtime.skipped = Math.max(0, this.runtime.skipped - 1);
        reopened++;
      }
    }
    if (reopened) this.refreshMaterialsFromLedger(ctx.needLedger, true);
    return reopened;
  }

  /** Creative: conjure the item for a job; repeated failures fail ALL jobs of that block type. */
  private async conjureFor(
    job: BuildJob,
    conjureFails: Map<string, number>,
    markDone: (job: BuildJob, res: "placed" | "skipped" | "failed") => void,
    board?: JobBoard
  ): Promise<void> {
    const bot = this.instance.bot;
    if (!bot) return;
    const itemName = itemNameForBlock(job.name)[0] ?? job.name;
    const ok = await creativeEnsureItem(bot, itemName, 1);
    if (ok) {
      conjureFails.delete(job.name);
      return;
    }
    const fails = (conjureFails.get(job.name) ?? 0) + 1;
    conjureFails.set(job.name, fails);
    if (fails >= 3) {
      this.log().warn("Creative item unavailable", `${itemName} — blocks of this type are marked failed`);
      if (board) {
        for (const j of board.openJobs()) {
          if (j.name === job.name) markDone(j, "failed");
        }
      } else {
        markDone(job, "failed");
      }
    }
  }

  /** Survival just-in-time item supply for one job (ledger fetch first). */
  private async ensureItemFor(ctx: LoopCtx, job: BuildJob): Promise<boolean> {
    const { token, needLedger } = ctx;
    const names = itemNameForBlock(job.name);
    const remainingNeed = Math.max(1, Math.min(needLedger.get(job.name) ?? 1, 256));

    if (this.stock.stockOf(names) > 0) {
      const bot = this.instance.bot;
      if (bot && bot.inventory.emptySlotCount() < 2) {
        this.setActivity(`Making inventory room for ${job.name}…`, job.name);
        await makeInventoryRoom(this.instance, this.stock, new Set(names), 3, token, (l) => this.setActivity(l, job.name));
      }
      const space = this.instance.bot ? inventorySpaceFor(this.instance.bot, names[0] ?? job.name) : 0;
      const wanted = Math.max(1, Math.min(remainingNeed, space));
      this.setActivity(`Fetching from marked storage: ${job.name} ×${wanted}`, job.name);
      const got = await fetchFromStorage(this.instance, this.stock, names, wanted, token, (l) =>
        this.setActivity(l, job.name)
      );
      this.refreshMaterialsFromLedger(needLedger, true);
      if (got > 0) return this.hasItemForBlock(job.name);
    }

    if (ctx.collectMissing) {
      try {
        const addCount = Math.min(remainingNeed, 64);
        this.setActivity(`Acquiring: ${job.name} ×${addCount}`, job.name);
        await this.acquireOneMaterial(job.name, addCount, token, ctx.report, () =>
          this.refreshMaterialsFromLedger(needLedger, true)
        );
      } catch (e) {
        if (token.cancelled) throw e;
        this.log().warn(`Mid-build acquire failed: ${job.name}`, e instanceof Error ? e.message : String(e));
      }
      this.refreshMaterialsFromLedger(needLedger, true);
      return this.hasItemForBlock(job.name);
    }
    return this.hasItemForBlock(job.name);
  }

  /** Pre-build acquisition pass over every missing material. */
  private async preBuildAcquire(ctx: LoopCtx): Promise<void> {
    const { token, report, needLedger } = ctx;
    this.setPhase("acquiring", "collecting missing materials…");
    this.setActivity("Picking up dropped items…", null);
    try {
      await this.instance.gather.runCollectDrops(undefined, 24, token, (p) => {
        report(p);
        this.setActivity(p.label ?? "Drops…", null);
        this.refreshMaterialsFromLedger(needLedger);
      });
    } catch (e) {
      if (token.cancelled) throw e;
    }
    this.refreshMaterialsFromLedger(needLedger, true);

    const missingList = this.materialsFromNeedMap(needLedger).filter((m) => m.missing > 0);
    let i = 0;
    for (const m of missingList) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      i++;
      this.setActivity(`Collecting: ${m.name} ×${m.missing} (${i}/${missingList.length})`, m.name);
      report({ done: i - 1, total: missingList.length, label: `collect ${m.name} ×${m.missing}` });
      try {
        await this.acquireOneMaterial(m.name, m.missing, token, report, () =>
          this.refreshMaterialsFromLedger(needLedger, true)
        );
      } catch (e) {
        if (token.cancelled) throw e;
        this.log().warn(`Could not collect: ${m.name}`, e instanceof Error ? e.message : String(e));
        this.setActivity(`Failed: ${m.name} — ${e instanceof Error ? e.message : String(e)}`, m.name);
      }
      this.refreshMaterialsFromLedger(needLedger, true);
    }
    this.setActivity(null, null);
    this.refreshMaterialsFromLedger(needLedger, true);
  }

  /**
   * Mid-build acquisition when the loop ran dry:
   * quick drop sweep → ledger fetch for top missing → (collectMissing) full chain.
   * Returns how many relevant items were gained.
   */
  private async midBuildAcquire(ctx: LoopCtx, missingNames: Set<string>, passNo: number): Promise<number> {
    const { token, needLedger } = ctx;
    const bot = this.instance.bot;
    if (!bot) return 0;

    const missing = this.materialsFromNeedMap(needLedger).filter((m) => m.need > 0 && m.have <= 0);
    if (!missing.length) return 0;
    const allNames = new Set<string>();
    for (const m of missing) for (const n of itemNameForBlock(m.name)) allNames.add(n);
    const countAll = () => this.countHaveItem([...allNames]);
    const before = countAll();

    this.setPhase("acquiring", `build waiting — material pass ${passNo}`);
    this.setActivity("Collecting dropped build materials…", null);
    try {
      await runSmartCollectDrops(this.instance, undefined, 20, token, () => {}, 15_000);
    } catch (e) {
      if (token.cancelled) throw e;
    }

    // ledger fetch for the top few missing materials
    for (const m of missing.slice(0, 3)) {
      if (token.cancelled) throw new Error(token.reason ?? "cancelled");
      const names = itemNameForBlock(m.name);
      if (this.stock.stockOf(names) <= 0) continue;
      if (bot.inventory.emptySlotCount() < 2) {
        await makeInventoryRoom(this.instance, this.stock, new Set(names), 3, token, (l) => this.setActivity(l));
      }
      const space = inventorySpaceFor(bot, names[0] ?? m.name);
      const wanted = Math.max(1, Math.min(needLedger.get(m.name) ?? 1, space));
      this.setActivity(`Fetching from marked storage: ${m.name} ×${wanted}`, m.name);
      await fetchFromStorage(this.instance, this.stock, names, wanted, token, (l) => this.setActivity(l, m.name));
      this.refreshMaterialsFromLedger(needLedger, true);
    }

    if (countAll() > before) {
      this.setActivity(`Building: ${ctx.schematicName}`, null);
      this.setPhase("building", `build continuing: ${ctx.schematicName}`);
      missingNames.clear();
      return countAll() - before;
    }

    if (ctx.collectMissing) {
      for (const m of missing.slice(0, 2)) {
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        try {
          await this.acquireOneMaterial(m.name, Math.min(m.missing || 1, 64), token, ctx.report, () =>
            this.refreshMaterialsFromLedger(needLedger, true)
          );
        } catch (e) {
          if (token.cancelled) throw e;
          this.log().warn(
            `Could not acquire material during build: ${m.name}`,
            e instanceof Error ? e.message : String(e)
          );
        }
      }
    }

    const gained = countAll() - before;
    this.setActivity(`Building: ${ctx.schematicName}`, null);
    this.setPhase("building", `build continuing: ${ctx.schematicName}`);
    if (gained > 0) missingNames.clear();
    return gained;
  }
}

export {
  listSchematics,
  getSchematicMeta,
  deleteSchematic,
  addSchematicFromBase64,
  addCayaJsonSchematic,
  loadParsedSchematic,
  materialCounts
} from "./library";
export type { BuildOrigin, BuildRuntime, MaterialNeed, SchematicMeta, SchematicBlock, BuildPlacedBlock } from "./types";
export { emptyBuildRuntime, normalizePlaceOrder } from "./types";
export type { BuildTransform, RotateY } from "./transform";

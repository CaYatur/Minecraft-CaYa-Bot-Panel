import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { createBot, type Bot } from "mineflayer";
import { CHAT_LOGS_DIR } from "../config/paths";
import {
  applyLearnedPrefix,
  extractNameDecor,
  isLikelySystemMessage,
  isValidPlayerChatBody,
  lineIncludesUsername,
  parseChatComponent,
  parseChatMessage,
  prefixFromDisplayName,
  resolveUsernameFromSender,
  stripColorCodes
} from "../modules/chat/parse";
import { BuildService, normalizePlaceOrder } from "../modules/build";
import { CombatService } from "../modules/combat";
import { CraftService } from "../modules/craft";
import { FarmService } from "../modules/farm";
import { GatherService } from "../modules/gather";
import { snapshotInventory, usedMainSlots } from "../modules/inventory";
import { depositToChest, withdrawFromChest } from "../modules/inventory/chestOps";
import { runFollow, runGoto, runGotoPlayer, runParkourGoto, stopMovement } from "../modules/movement";
import { SurvivalService } from "../modules/survival";
import type {
  BotConfig,
  BotRuntimeState,
  BotSnapshot,
  BotStatus,
  ChatEntry,
  InventorySnapshot,
  ServerProfile,
  TaskSummary
} from "../types";
import { defaultRuntime } from "../types";
import { chatComponentToText, friendlyError } from "../utils/chatText";
import { createLogger, type BotLogger } from "../utils/logger";
import { ChatRateLimiter } from "./ChatRateLimiter";
import { PRIORITY, TaskQueue } from "./TaskQueue";

const RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];
const CHAT_RING_CAP = 500;
const POSITION_EMIT_MS = 250; // ≤4 Hz (TODO.md §6)

/**
 * Wraps a single mineflayer bot with a status state machine, auto-reconnect,
 * chat capture and a rate-limited chat sender. Emits typed events consumed by
 * BotManager: "status" | "vitals" | "position" | "chat" | "chatQueue".
 */
export class BotInstance extends EventEmitter {
  status: BotStatus = "stopped";
  runtime: BotRuntimeState = defaultRuntime();
  readonly chatHistory: ChatEntry[] = [];
  readonly tasks = new TaskQueue();

  bot: Bot | null = null;
  readonly combat: CombatService;
  readonly survival: SurvivalService;
  readonly gather: GatherService;
  readonly craft: CraftService;
  readonly build: BuildService;
  readonly farm: FarmService;
  private foodWatchTimer: NodeJS.Timeout | null = null;
  private nearbyTick = 0;
  private lastNearbyKey = "";
  /** son 2 sn sohbet dedup (chat olayı + message çiftini önle) */
  private recentChatKeys = new Map<string, number>();
  /** başarılı isim+ayırıcı kalıpları (plugin prefix öğrenme) */
  private learnedChatUsers = new Set<string>();
  private wantsRunning = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private posTimer: NodeJS.Timeout | null = null;
  private lastPosKey = "";
  private pingCounter = 0;
  private lastInventory: InventorySnapshot | null = null;
  private invTimer: NodeJS.Timeout | null = null;
  private invWasFull = false;
  private readonly limiter: ChatRateLimiter;
  private readonly log: BotLogger;

  constructor(
    public config: BotConfig,
    private readonly getServer: (id: string) => ServerProfile | undefined,
    private readonly getWorldChests?: (
      serverId: string
    ) => Array<{ x: number; y: number; z: number; dimension: string; items: { name: string; count: number }[] }>
  ) {
    super();
    this.log = createLogger("bot", config.id);
    this.combat = new CombatService(this);
    this.survival = new SurvivalService(this);
    this.gather = new GatherService(this);
    this.craft = new CraftService(this);
    this.build = new BuildService(this);
    this.farm = new FarmService(this);
    this.limiter = new ChatRateLimiter(
      (text) => {
        if (this.bot && this.status === "online") {
          this.bot.chat(text);
          this.log.debug(`Sent to chat: ${text}`);
        } else {
          this.log.warn("Bot offline — chat message could not be sent", text);
        }
      },
      () => this.config.chat.minMessageIntervalMs,
      (n) => this.emit("chatQueue", n)
    );

    this.tasks.on("update", () => {
      this.emit("task", {
        botId: this.config.id,
        current: this.tasks.currentSummary,
        queue: this.tasks.queueSummaries
      });
    });
    this.tasks.on("taskDone", (s: TaskSummary) => {
      this.log.success(`Task completed: ${s.label}`);
      this.emit("taskEvent", {
        botId: this.config.id,
        kind: "done" as const,
        taskId: s.id,
        taskType: s.type,
        label: s.label,
        state: s.state,
        progress: s.progress
      });
    });
    this.tasks.on("taskDetached", (s: TaskSummary) => {
      // issue #4: iptali yutan asılı runner terk edildi — kuyruk akmaya devam eder
      this.log.warn(`Task force-detached (hung runner abandoned): ${s.label}`, s.error);
    });
    this.tasks.on("taskFailed", (s: TaskSummary, err: string) => {
      this.log.error(`Task failed: ${s.label}`, err);
      this.emit("taskEvent", {
        botId: this.config.id,
        kind: "failed" as const,
        taskId: s.id,
        taskType: s.type,
        label: s.label,
        state: s.state,
        error: err || s.error || "",
        progress: s.progress
      });
    });
  }

  /** Persistent world-memory chests for this bot's server (stock ledger seed). */
  getKnownChests(): Array<{
    x: number;
    y: number;
    z: number;
    dimension: string;
    items: { name: string; count: number }[];
  }> {
    return this.getWorldChests?.(this.config.serverId) ?? [];
  }

  /** Menzildeki oyuncular (entity varsa distance; yoksa tab-only). */
  getNearbyPlayers(maxDist = 48): Array<{
    username: string;
    distance: number | null;
    hasEntity: boolean;
    x?: number;
    y?: number;
    z?: number;
  }> {
    const bot = this.bot;
    if (!bot?.entity || this.status !== "online") return [];
    const out: Array<{
      username: string;
      distance: number | null;
      hasEntity: boolean;
      x?: number;
      y?: number;
      z?: number;
    }> = [];
    for (const [name, p] of Object.entries(bot.players ?? {})) {
      if (!name || name === bot.username) continue;
      const ent = p?.entity;
      if (ent?.position) {
        const d = bot.entity.position.distanceTo(ent.position);
        if (d <= maxDist) {
          out.push({
            username: name,
            distance: Math.round(d * 10) / 10,
            hasEntity: true,
            x: Math.round(ent.position.x * 10) / 10,
            y: Math.round(ent.position.y * 10) / 10,
            z: Math.round(ent.position.z * 10) / 10
          });
        }
      } else {
        out.push({ username: name, distance: null, hasEntity: false });
      }
    }
    out.sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999));
    return out;
  }

  private emitNearby(force = false) {
    const list = this.getNearbyPlayers(64);
    const key = list.map((p) => `${p.username}:${p.distance ?? "t"}`).join("|");
    if (!force && key === this.lastNearbyKey) return;
    this.lastNearbyKey = key;
    this.emit("nearby", { botId: this.config.id, players: list });
    // tab isimleri join/leave for
    this.emit("tabPlayers", { botId: this.config.id, names: Object.keys(this.bot?.players ?? {}).filter((n) => n !== this.bot?.username) });
  }

  // ---- lifecycle ------------------------------------------------------------

  start() {
    if (this.wantsRunning && (this.bot || this.reconnectTimer)) return;
    this.wantsRunning = true;
    this.reconnectAttempt = 0;
    this.runtime.kickReason = undefined;
    this.runtime.lastError = undefined;
    this.connect();
  }

  stop() {
    this.wantsRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.tasks.cancelAll("bot durduruldu");
    this.limiter.clear();
    const bot = this.bot;
    if (bot) {
      try {
        bot.quit();
      } catch {
        /* already closed */
      }
    }
    this.teardownBot();
    this.setStatus("stopped");
    this.log.info("Bot stopped");
  }

  /** called by manager before deleting the instance */
  dispose() {
    this.stop();
    this.removeAllListeners();
  }

  sendChat(text: string) {
    this.limiter.enqueue(text);
  }

  get chatQueueLength(): number {
    return this.limiter.length;
  }

  /** modules (combat vb.) for paylaşılan logger — sohbete asla yazmaz (İ1) */
  getLogger(): BotLogger {
    return this.log;
  }

  getSnapshot(): BotSnapshot {
    return {
      config: this.config,
      status: this.status,
      runtime: this.runtime,
      chatQueueLength: this.limiter.length,
      tasks: { current: this.tasks.currentSummary, queue: this.tasks.queueSummaries },
      inventory: this.lastInventory,
      combat: this.combat.getRuntime(),
      build: this.build.getRuntime()
    };
  }

  /**
   * Bot bağlı kalır; tüm görev / hareket / combat companion / inşaat / pathfinder temizlenir.
   * Takılma / bug sonrası sunucu kapat-aç yerine panelden kurtarma.
   */
  resetAllWork(reason = "all work reset from panel") {
    // 1) Trip build abort gate FIRST so pathNear/place/cleanup exit even while
    //    the runner is mid-await (was ignoring TaskQueue cancel alone).
    try {
      this.build.hardReset(reason);
    } catch {
      try {
        this.build.stopBuild(reason);
      } catch {
        /* */
      }
    }

    // 2) cancelAll clears held + cancels current token (hardReset already cancelled
    //    build task types; this clears movement/gather/etc. too).
    try {
      this.tasks.cancelAll(reason);
    } catch {
      /* */
    }

    // stopMovement also cancelAll + pathfinder clear — keep for movement side effects
    try {
      // Avoid nested cancelAll reason thrash: only freeze pathfinder here
      const bot0 = this.bot;
      if (bot0) {
        try {
          const pf = bot0.pathfinder as unknown as { setGoal?(g: null): void; stop?(): void };
          pf.stop?.();
          pf.setGoal?.(null);
        } catch {
          /* */
        }
        try {
          bot0.clearControlStates();
        } catch {
          /* */
        }
      }
    } catch {
      /* */
    }
    try {
      this.combat.stopCombat(reason);
    } catch {
      /* */
    }
    try {
      this.combat.clearCompanion(reason);
    } catch {
      /* */
    }

    const bot = this.bot;
    if (bot) {
      try {
        const win = (bot as { currentWindow?: { id?: number } | null }).currentWindow;
        if (win) bot.closeWindow(win as never);
      } catch {
        /* */
      }
      try {
        const pf = bot.pathfinder as unknown as { setGoal?(g: null): void; stop?(): void };
        pf.stop?.();
        pf.setGoal?.(null);
      } catch {
        /* */
      }
      try {
        const digBot = bot as unknown as { stopDigging?(): void };
        digBot.stopDigging?.();
      } catch {
        /* */
      }
      try {
        bot.clearControlStates();
      } catch {
        /* */
      }
      // Short re-clear while in-flight place may reassert a goal — keep brief so a
      // follow/goto right after reset is not killed for seconds (regression guard).
      const reClear = () => {
        if (!this.bot || this.bot !== bot) return;
        // If user already queued a new non-idle task, do not stomp its pathfinder.
        const cur = this.tasks.currentSummary;
        if (cur && cur.state === "running" && cur.type !== "build" && !String(cur.type).startsWith("build-")) {
          return;
        }
        try {
          const pf = bot.pathfinder as unknown as { setGoal?(g: null): void; stop?(): void };
          pf.stop?.();
          pf.setGoal?.(null);
        } catch {
          /* */
        }
        try {
          const digBot = bot as unknown as { stopDigging?(): void };
          digBot.stopDigging?.();
        } catch {
          /* */
        }
        try {
          bot.clearControlStates();
        } catch {
          /* */
        }
      };
      setTimeout(reClear, 100);
      setTimeout(reClear, 350);
    }

    this.log.info("All work reset (soft-reset)", reason);
    // görev paneli / durum
    this.emit("task", {
      botId: this.config.id,
      current: this.tasks.currentSummary,
      queue: this.tasks.queueSummaries
    });
    // force build snapshot to idle so panel stuck badge clears immediately
    try {
      this.emit("build", { botId: this.config.id, build: this.build.getRuntime() });
    } catch {
      /* */
    }
  }

  /**
   * Panel/otomasyon aksiyonlarını görev kuyruğuna çevirir (Faz 4: hareket).
   * Dönen özet null ise aksiyon anlık çalışmıştır (stop/chat gibi), görev değildir.
   */
  enqueueAction(action: Record<string, unknown>): TaskSummary | null {
    const type = String(action.type ?? "");
    switch (type) {
      case "goto": {
        const x = num(action.x, "x");
        const y = num(action.y, "y");
        const z = num(action.z, "z");
        const range = clampRange(action.range);
        const label = (action.label as string) ?? `git: ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`;
        return this.tasks.enqueue(
          { type, label, priority: PRIORITY.USER, params: { x, y, z, range } },
          () => (token, report) => runGoto(this, x, y, z, range, token, report)
        );
      }
      case "parkour-goto": {
        const x = num(action.x, "x");
        const y = num(action.y, "y");
        const z = num(action.z, "z");
        const range = clampRange(action.range ?? 1);
        return this.tasks.enqueue(
          {
            type,
            label: `parkur: ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`,
            priority: PRIORITY.USER,
            params: { x, y, z, range }
          },
          () => (token, report) => runParkourGoto(this, x, y, z, range, token, report)
        );
      }
      case "goto-player": {
        const player = str(action.player, "player");
        const range = clampRange(action.range ?? 2);
        return this.tasks.enqueue(
          { type, label: `goto player: ${player}`, priority: PRIORITY.USER, params: { player, range } },
          () => (token, report) => runGotoPlayer(this, player, range, token, report)
        );
      }
      case "follow": {
        // toggle-aware: enabled false → companion follow kapat
        if (action.enabled === false) {
          this.combat.setFollow(str(action.player, "player"), false);
          return null;
        }
        const player = str(action.player, "player");
        const distance = clampRange(action.distance ?? 3);
        this.combat.setFollow(player, true, distance);
        return this.tasks.currentSummary?.type === "follow" ? this.tasks.currentSummary : null;
      }
      case "stop":
        stopMovement(this);
        this.combat.clearCompanion("user stop");
        this.log.info("Movement and task queue stopped (user)");
        return null;
      // Bug / takılma: bot bağlı kalsın, tüm işleri drop (sunucu restart gerekmez)
      case "reset-work":
      case "reset-all":
      case "işleri-sıfırla":
      case "soft-reset":
        this.resetAllWork(String(action.reason ?? "all work reset from panel"));
        return null;
      // yakındaki oyuncular — toggle companion
      case "social-follow": {
        const enabled = action.enabled !== false && action.enabled !== "false";
        this.combat.setFollow(str(action.player, "player"), enabled, action.distance != null ? Number(action.distance) : undefined);
        return null;
      }
      case "social-attack": {
        const enabled = action.enabled !== false && action.enabled !== "false";
        this.combat.setAttack(str(action.player, "player"), enabled);
        return null;
      }
      case "social-protect": {
        const enabled = action.enabled !== false && action.enabled !== "false";
        const wl = Array.isArray(action.whitelist)
          ? (action.whitelist as unknown[]).map(String)
          : typeof action.whitelist === "string"
            ? String(action.whitelist)
                .split(/[,;\s]+/)
                .filter(Boolean)
            : undefined;
        const aggroRaw = action.protectAggro != null ? String(action.protectAggro) : "";
        const protectAggro =
          aggroRaw === "non_whitelist" || aggroRaw === "threats"
            ? (aggroRaw as "threats" | "non_whitelist")
            : undefined;
        this.combat.setProtect(str(action.player, "player"), enabled, {
          followDistance: action.followDistance != null ? Number(action.followDistance) : undefined,
          range: action.range != null ? Number(action.range) : undefined,
          protectAggro,
          retaliateMobs: action.retaliateMobs != null ? Boolean(action.retaliateMobs) : undefined,
          retaliatePlayers: action.retaliatePlayers != null ? Boolean(action.retaliatePlayers) : undefined,
          whitelist: wl,
          setAsMain:
            action.setAsMain === true || action.setAsMain === "true"
              ? true
              : action.setAsMain === false || action.setAsMain === "false"
                ? false
                : undefined
        });
        return null;
      }
      case "protect-settings": {
        // combat paneli — koruma listesini bozmadan ayar
        const wl = Array.isArray(action.whitelist)
          ? (action.whitelist as unknown[]).map(String)
          : typeof action.whitelist === "string"
            ? String(action.whitelist)
                .split(/[,;\s]+/)
                .filter(Boolean)
            : undefined;
        const aggroRaw = action.protectAggro != null ? String(action.protectAggro) : "";
        this.combat.updateProtectSettings({
          followDistance: action.followDistance != null ? Number(action.followDistance) : undefined,
          range: action.range != null ? Number(action.range) : undefined,
          protectAggro:
            aggroRaw === "non_whitelist" || aggroRaw === "threats"
              ? (aggroRaw as "threats" | "non_whitelist")
              : undefined,
          retaliateMobs: action.retaliateMobs != null ? Boolean(action.retaliateMobs) : undefined,
          retaliatePlayers: action.retaliatePlayers != null ? Boolean(action.retaliatePlayers) : undefined,
          whitelist: wl
        });
        return null;
      }
      case "chat": {
        const text = str(action.text, "text");
        this.sendChat(text);
        return null;
      }
      // ---- Faz 6 combat --------------------------------------------------------
      case "attack": {
        // enabled false → saldırı toggle kapat; true/yok → başlat (toggle panel)
        if (action.enabled === false || action.enabled === "false") {
          this.combat.setAttack(str(action.player, "player"), false);
          return null;
        }
        if (action.toggle === true || action.enabled === true) {
          this.combat.setAttack(str(action.player, "player"), true);
          return null;
        }
        return this.combat.enqueueAttackPlayer(str(action.player, "player"));
      }
      case "clear-mobs":
        return this.combat.enqueueClearMobs(Number(action.radius ?? 16));
      case "flee":
        return this.combat.enqueueFlee(action.from ? String(action.from) : undefined);
      case "loot-death":
        return this.combat.enqueueLootDeath();
      case "stop-combat":
        this.combat.stopCombat("panel");
        return null;
      // ---- Faz 7 survival ------------------------------------------------------
      case "eat":
        return this.survival.enqueueEatNow();
      case "hunt":
        return this.survival.enqueueHunt(Number(action.radius ?? 32));
      case "cook":
        return this.survival.enqueueCook();
      case "acquire-food":
        return this.survival.enqueueAcquireFood();
      // ---- Faz 8 gather --------------------------------------------------------
      case "collect-wood":
      case "odun-topla":
        return this.gather.enqueueCollectWood(
          Number(action.count ?? 16),
          action.logType ? String(action.logType) : undefined,
          PRIORITY.USER,
          action.countMode === "add" ? "add" : "target"
        );
      case "collect":
      case "collect-item":
      case "collect_item":
      case "collect-block":
        return this.gather.enqueueCollectBlock(
          String(action.item ?? action.block ?? action.name ?? ""),
          Number(action.count ?? 8),
          PRIORITY.USER,
          action.countMode === "add" ? "add" : "target"
        );
      case "collect-drops":
      case "eşya-topla":
        return this.gather.enqueueCollectDrops(action.filter ? String(action.filter) : undefined, Number(action.radius ?? 16));
      case "mine":
      case "maden-topla":
        return this.gather.enqueueMine(
          String(action.ore ?? "iron"),
          Number(action.count ?? 8),
          action.mode === "utility" ? "utility" : "legit",
          PRIORITY.USER,
          action.countMode === "add" ? "add" : "target"
        );
      // ---- Faz 9 craft ---------------------------------------------------------
      case "craft":
      case "üret":
        return this.craft.enqueueCraft(String(action.item ?? action.name ?? ""), Number(action.count ?? 1));
      // ---- Faz 10 depo ---------------------------------------------------------
      case "deposit":
      case "depoya-bırak":
      case "depoya-drop":
        return this.enqueueDeposit({
          filter: String(action.filter ?? ""),
          items: Array.isArray(action.items)
            ? (action.items as unknown[]).map(String)
            : typeof action.items === "string" && action.items.trim()
              ? String(action.items).split(/[,;\s]+/).filter(Boolean)
              : undefined,
          x: action.x != null && action.x !== "" ? Number(action.x) : undefined,
          y: action.y != null && action.y !== "" ? Number(action.y) : undefined,
          z: action.z != null && action.z !== "" ? Number(action.z) : undefined
        });
      case "withdraw":
      case "depodan-al":
        return this.enqueueWithdraw(String(action.item ?? ""), Number(action.count ?? 1), {
          x: action.x != null && action.x !== "" ? Number(action.x) : undefined,
          y: action.y != null && action.y !== "" ? Number(action.y) : undefined,
          z: action.z != null && action.z !== "" ? Number(action.z) : undefined
        });
      case "drop-items":
      case "drop_items":
      case "discard-item":
      case "discard_items":
      case "eşya-at":
        return this.enqueueDropItems({
          item: String(action.item ?? action.name ?? ""),
          count: Number(action.count ?? 1),
          mode:
            action.dropMode === "all" || action.dropMode === "keep"
              ? action.dropMode
              : "count",
          match: action.match === "contains" ? "contains" : "exact",
          respectKeepItems: action.respectKeepItems !== false && action.respectKeepItems !== "false",
          failIfMissing: action.failIfMissing === true || action.failIfMissing === "true",
          requireCount: action.requireCount === true || action.requireCount === "true"
        });
      case "fetch":
      case "getir":
        return this.enqueueFetch(String(action.item ?? ""), Number(action.count ?? 1), String(action.player ?? action.kime ?? ""));
      // ---- Faz 14 yapı / şema --------------------------------------------------
      case "build-schematic":
      case "yapı":
      case "build": {
        const originMode = String(action.originMode ?? action.mode ?? "here") as "here" | "coords" | "player";
        const server = this.getServer(this.config.serverId);
        const versionHint =
          action.version != null
            ? String(action.version)
            : server?.version && server.version !== "auto"
              ? server.version
              : "1.20.4";
        return this.build.enqueueBuild({
          schematicId: String(action.schematicId ?? action.id ?? ""),
          origin: {
            mode: originMode,
            x: action.x != null ? Number(action.x) : undefined,
            y: action.y != null ? Number(action.y) : undefined,
            z: action.z != null ? Number(action.z) : undefined,
            player: action.player ? String(action.player) : undefined
          },
          allowPartial: action.allowPartial === true || action.allowPartial === "true",
          collectMissing: action.collectMissing === true || action.collectMissing === "true",
          placeOrder: normalizePlaceOrder(action.placeOrder),
          resumeOnReconnect: action.resumeOnReconnect !== false && action.resumeOnReconnect !== "false",
          versionHint,
          rotateY: action.rotateY != null ? Number(action.rotateY) : 0,
          mirrorX: action.mirrorX === true || action.mirrorX === "true",
          mirrorZ: action.mirrorZ === true || action.mirrorZ === "true"
        });
      }
      case "collect-build-materials":
      case "build-collect-missing": {
        const server = this.getServer(this.config.serverId);
        const versionHint =
          action.version != null
            ? String(action.version)
            : server?.version && server.version !== "auto"
              ? server.version
              : "1.20.4";
        const ry = action.rotateY != null ? Number(action.rotateY) : 0;
        const rotateY = (ry === 90 || ry === 180 || ry === 270 ? ry : 0) as 0 | 90 | 180 | 270;
        return this.build.enqueueCollectMissing({
          schematicId: String(action.schematicId ?? action.id ?? ""),
          versionHint,
          transform: {
            rotateY,
            mirrorX: action.mirrorX === true || action.mirrorX === "true",
            mirrorZ: action.mirrorZ === true || action.mirrorZ === "true"
          }
        });
      }
      case "stop-build":
        this.build.stopBuild("panel");
        return null;
      case "scan-storage":
      case "mark-storage":
        return this.build.enqueueScanStorage(
          Math.max(4, Math.min(64, Number(action.radius ?? 32) || 32))
        );
      // ---- Faz 19 tarım (issue #5) ---------------------------------------------
      case "till":
      case "till-soil":
      case "till_soil":
      case "çapala":
        return this.farm.enqueueTill(farmAreaFrom(action));
      case "plant":
      case "plant-crops":
      case "plant_crops":
      case "ekim":
        return this.farm.enqueuePlant({
          ...farmAreaFrom(action),
          crop: action.crop != null && action.crop !== "" ? String(action.crop) : undefined
        });
      case "harvest":
      case "harvest-crops":
      case "harvest_crops":
      case "hasat":
        return this.farm.enqueueHarvest({
          ...farmAreaFrom(action),
          replant: action.replant !== false && action.replant !== "false"
        });
      case "farm-cycle":
      case "farm_cycle":
      case "farm":
      case "tarla":
        return this.farm.enqueueFarmCycle({
          ...farmAreaFrom(action),
          crop: action.crop != null && action.crop !== "" ? String(action.crop) : undefined,
          replant: action.replant !== false && action.replant !== "false",
          till: action.till !== false && action.till !== "false",
          depositX: numOpt(action.depositX),
          depositY: numOpt(action.depositY),
          depositZ: numOpt(action.depositZ),
          depositNearest: action.depositNearest === true || action.depositNearest === "true",
          intervalSec: numOpt(action.intervalSec),
          maxCycles: numOpt(action.maxCycles)
        });
      default:
        throw new Error(`Unknown action type: ${type || "(empty)"}`);
    }
  }

  /**
   * Issue #5 storage fix: verified deposit (chestOps). Eski sürüm hataları
   * yutup "bitti" diyordu — artık taşınan/taşınamayan raporlanır, hiçbir şey
   * sığmadıysa görev dürüstçe FAIL olur. Koordinat verilirse belirli sandık.
   */
  private enqueueDeposit(opts: { filter?: string; items?: string[]; x?: number; y?: number; z?: number; keepCounts?: Record<string, number> }) {
    const where = opts.x != null && opts.y != null && opts.z != null ? ` @${Math.floor(opts.x)},${Math.floor(opts.y)},${Math.floor(opts.z)}` : "";
    const what = opts.items?.length ? opts.items.join(",").slice(0, 24) : opts.filter || "all";
    return this.tasks.enqueue(
      {
        type: "deposit",
        label: `deposit: ${what}${where}`,
        priority: PRIORITY.USER,
        params: { ...opts },
        requeueOnPreempt: true
      },
      () => async (token, report) => {
        const res = await depositToChest(this, opts, token, report);
        if (res.chestFull) {
          this.log.warn(
            "Deposit partial — chest full",
            res.left.map((l) => `${l.name}×${l.count}`).join(", ")
          );
        }
      }
    );
  }

  private enqueueWithdraw(item: string, count: number, at?: { x?: number; y?: number; z?: number }) {
    const where = at && at.x != null && at.y != null && at.z != null ? ` @${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}` : "";
    return this.tasks.enqueue(
      { type: "withdraw", label: `depodan al: ${item}×${count}${where}`, priority: PRIORITY.USER, params: { item, count, ...at }, requeueOnPreempt: true },
      () => async (token, report) => {
        await withdrawFromChest(this, { item, count, ...at }, token, report);
      }
    );
  }

  private enqueueDropItems(options: {
    item: string;
    count: number;
    mode: "count" | "all" | "keep";
    match: "exact" | "contains";
    respectKeepItems: boolean;
    failIfMissing: boolean;
    requireCount: boolean;
  }) {
    const requestedItem = options.item.replace(/^minecraft:/, "").trim().toLowerCase();
    if (!requestedItem) throw new Error("Item name required to drop");

    const count = Math.max(0, Math.floor(Number.isFinite(options.count) ? options.count : 0));
    if (options.mode !== "all" && count < 0) throw new Error("Item count must be 0 or greater");

    const labelMode = options.mode === "all" ? "all" : options.mode === "keep" ? `${count} drop` : `${count} at`;
    return this.tasks.enqueue(
      {
        type: "drop-items",
        label: `drop item: ${requestedItem} (${labelMode})`,
        priority: PRIORITY.USER,
        params: { ...options, item: requestedItem, count },
        // Eşya atmak geri alınamaz; savunma görevi keserse otomatik tekrar çalıştırma.
        requeueOnPreempt: false
      },
      () => async (token, report) => {
        const bot = this.bot;
        if (!bot || this.status !== "online") throw new Error("Bot offline");

        const matchesName = (name: string) => {
          const normalized = name.replace(/^minecraft:/, "").toLowerCase();
          return options.match === "contains" ? normalized.includes(requestedItem) : normalized === requestedItem;
        };
        const isProtectedSlot = (slot: number) => slot < 9 || slot === 45;
        const isKeepProtected = (name: string) =>
          options.respectKeepItems &&
          this.config.inventory.keepItems.some((keep) => {
            const normalized = keep.replace(/^minecraft:/, "").trim().toLowerCase();
            return Boolean(normalized) && (normalized === name.toLowerCase() || name.toLowerCase().includes(normalized));
          });
        const eligible = () =>
          bot.inventory
            .items()
            .filter((stack) => !isProtectedSlot(stack.slot) && matchesName(stack.name) && !isKeepProtected(stack.name));

        const initial = eligible();
        const available = initial.reduce((sum, stack) => sum + stack.count, 0);
        const protectedMatches = bot.inventory
          .items()
          .filter((stack) => matchesName(stack.name) && (isProtectedSlot(stack.slot) || isKeepProtected(stack.name)))
          .reduce((sum, stack) => sum + stack.count, 0);

        if (available <= 0) {
          if (options.failIfMissing) {
            const suffix = protectedMatches > 0 ? ` (${protectedMatches} kept on equipment/keep list)` : "";
            throw new Error(`No droppable ${requestedItem}${suffix}`);
          }
          report({ done: 0, total: 0, label: `${requestedItem}: nothing to drop` });
          return;
        }

        const planned =
          options.mode === "all"
            ? available
            : options.mode === "keep"
              ? Math.max(0, available - count)
              : Math.min(available, count);

        if (options.mode === "count" && options.requireCount && available < count) {
          throw new Error(`Not enough ${requestedItem} in inventory (${available}/${count}); nothing was dropped`);
        }
        if (planned <= 0) {
          report({ done: 0, total: 0, label: `${requestedItem}: keep amount already satisfied` });
          return;
        }

        let dropped = 0;
        report({ done: 0, total: planned, label: `${requestedItem} preparing` });
        while (dropped < planned) {
          if (token.cancelled) throw new Error(token.reason ?? "cancelled");
          const stack = eligible()[0];
          if (!stack) break;
          const amount = Math.min(stack.count, planned - dropped);
          try {
            await bot.toss(stack.type, stack.metadata ?? null, amount);
          } catch (error) {
            throw new Error(`Could not drop item (${stack.name}×${amount}): ${error instanceof Error ? error.message : String(error)}`);
          }
          dropped += amount;
          report({ done: dropped, total: planned, label: `${requestedItem} ${dropped}/${planned} dropped` });
          await bot.waitForTicks(1);
        }

        if (dropped < planned) {
          throw new Error(`Drop interrupted (${dropped}/${planned})`);
        }
      }
    );
  }

  private enqueueFetch(item: string, count: number, player: string) {
    return this.tasks.enqueue(
      { type: "fetch", label: `fetch: ${item}×${count} → ${player || "?"}`, priority: PRIORITY.USER, params: { item, count, player }, requeueOnPreempt: true },
      () => async (token, report) => {
        report({ done: 0, total: 3, label: "prepare" });
        const bot = this.bot;
        if (!bot || this.status !== "online") throw new Error("Bot offline");
        // Nested enqueue does not wait — continue if held; otherwise clear error (mine/craft/withdraw first)
        const have = bot.inventory.items().filter((i) => i.name.includes(item)).reduce((s, i) => s + i.count, 0);
        if (have < count) {
          throw new Error(
            `Not enough ${item} in inventory (${have}/${count}). Withdraw / mine / craft first, then fetch.`
          );
        }
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        report({ done: 1, total: 3, label: "goto player" });
        if (player) {
          await runGotoPlayer(this, player, 2, token, report);
        } else {
          throw new Error("Target player name required for fetch");
        }
        report({ done: 2, total: 3, label: "drop" });
        const stack = bot.inventory.items().find((i) => i.name.includes(item));
        if (!stack) throw new Error(`Item disappeared: ${item}`);
        try {
          await bot.toss(stack.type, null, Math.min(count, stack.count));
        } catch (e) {
          throw new Error(`Toss failed: ${e instanceof Error ? e.message : e}`);
        }
        report({ done: 3, total: 3, label: "getir bitti" });
      }
    );
  }

  // ---- connection -----------------------------------------------------------

  private connect() {
    const server = this.getServer(this.config.serverId);
    if (!server) {
      this.runtime.lastError = "Server profile not found — bot cannot connect to a server.";
      this.log.error(this.runtime.lastError);
      this.setStatus("error");
      return;
    }

    this.setStatus("connecting");
    this.log.info(`Connecting: ${server.host}:${server.port} (version: ${server.version})`);

    let bot: Bot;
    try {
      bot = createBot({
        host: server.host,
        port: server.port,
        username: this.config.username,
        auth: "offline",
        version: server.version === "auto" ? undefined : server.version,
        checkTimeoutInterval: 60_000,
        hideErrors: true // we surface errors ourselves via the panel log
      });
    } catch (err) {
      const msg = friendlyError(err);
      this.runtime.lastError = msg;
      this.log.error("Could not start connection", msg);
      // unsupported-version style errors won't fix themselves — don't loop
      if (/sürüm|version/i.test(msg)) {
        this.wantsRunning = false;
        this.setStatus("error");
      } else {
        this.setStatus("error");
        this.scheduleReconnect();
      }
      return;
    }

    this.bot = bot;
    this.hookBotEvents(bot);
  }

  private hookBotEvents(bot: Bot) {
    bot.once("login", () => {
      this.log.info("Logged in to server, waiting for spawn…");
    });

    let invHooked = false; // spawn fires on every respawn — hooks once per bot
    bot.on("spawn", () => {
      this.reconnectAttempt = 0;
      this.runtime.kickReason = undefined;
      this.runtime.lastError = undefined;
      this.updateDimension();
      this.setStatus("online");
      this.log.success("Bot entered the world (spawn)");
      this.emitVitals();
      this.startPositionLoop();
      if (!invHooked) {
        invHooked = true;
        this.hookInventory(bot);
        if (this.config.inventory.autoBestGear) this.loadArmorManager(bot);
        this.combat.attach(bot);
        this.survival.attach(bot);
        if (this.foodWatchTimer) clearInterval(this.foodWatchTimer);
        this.foodWatchTimer = setInterval(() => this.survival.tickFoodWatch(), 15_000);
      } else {
        // ölüm sonrası yeniden doğuş — combat attach tekrarlanmaz; koruma/takip resume
        this.combat.onRespawnOrSpawn();
      }
      this.scheduleInventorySync(); // full resync after respawn (TODO §12)
      this.build.onSpawn(); // resume a build interrupted by a disconnect
      this.emit("spawned", { botId: this.config.id });
      // yakındaki oyuncular paneli hemen dolsun
      setTimeout(() => this.emitNearby(true), 500);
    });

    bot.on("respawn", () => {
      this.updateDimension();
      this.log.info("Respawned / dimension changed");
      // bazı sunucularda spawn'dan önce respawn gelir
      this.combat.onRespawnOrSpawn();
    });

    bot.on("health", () => {
      this.runtime.health = round1(bot.health ?? 0);
      this.runtime.food = bot.food ?? 0;
      this.runtime.foodSaturation = round1(bot.foodSaturation ?? 0);
      this.emitVitals();
    });

    bot.on("experience", () => {
      this.runtime.xpLevel = bot.experience?.level ?? 0;
      this.emitVitals();
    });

    // death: CombatService kaydı + ölüm waypoint (BotManager deathAt dinler)
    bot.on("death", () => {
      this.log.warn("Bot died", `Position: ${fmtPos(this.runtime.position)}`);
    });

    bot.on("kicked", (reason: unknown) => {
      const text = chatComponentToText(reason) || String(reason);
      this.runtime.kickReason = text;
      this.log.error("Kicked from server", text);
      this.setStatus("kicked");
      // premium-doğrulama kick'inde tekrar denemek anlamsız
      if (text.includes("premium verification")) {
        this.wantsRunning = false;
      }
    });

    bot.on("error", (err: Error) => {
      const msg = friendlyError(err);
      this.runtime.lastError = msg;
      this.log.error("Connection error", msg);
      if (this.status !== "kicked") this.setStatus("error");
      this.scheduleReconnect();
    });

    bot.on("end", (reason: string) => {
      this.log.info(`Connection closed (${reason || "unknown"})`);
      if (this.tasks.currentSummary) {
        this.log.warn("Active tasks cancelled due to lost connection (task persistence: Phase 10)");
      }
      this.tasks.cancelAll("connection lost");
      this.teardownBot();
      if (this.wantsRunning) {
        this.scheduleReconnect();
      } else {
        this.setStatus("stopped");
      }
    });

    /**
     * Sohbet (Paper / plugin akıllı parse):
     * 1) mineflayer `chat`/`whisper` — kullanıcı adı hazır (legacy kalıp)
     * 2) `message` + sender UUID (1.19+ playerChat paketi 4. arg)
     * 3) JSON component (chat.type.text / clickEvent /msg)
     * 4) düz metin regex + öğrenilmiş isimler
     * Dedup: aynı oyuncu+metin 2 sn forde iki kez yazılmaz.
     */
    bot.on("chat", (username: string, message: string) => {
      if (!username || message == null) return;
      const msg = String(message);
      // eklenti bazen sistem satırını chat diye basar
      if (isLikelySystemMessage(msg) || isLikelySystemMessage(`${username}: ${msg}`)) {
        this.ingestServerChat(msg);
        return;
      }
      if (!isValidPlayerChatBody(msg, msg)) return;
      // chat olayı genelde sadece gövde verir — prefix yok
      this.ingestPlayerChat(username, msg, "player", undefined, undefined);
    });
    bot.on("whisper", (username: string, message: string) => {
      if (!username || message == null) return;
      const msg = String(message);
      if (!isValidPlayerChatBody(msg, msg)) return;
      this.ingestPlayerChat(username, msg, "whisper", undefined, undefined);
    });

    bot.on("message", (jsonMsg: any, position: string, sender?: unknown) => {
      if (position === "game_info") return;
      let plain = "";
      try {
        plain = String(jsonMsg?.toString?.() ?? "");
      } catch {
        return;
      }
      if (!plain.trim()) return;

      let ansi: string | undefined;
      try {
        ansi = typeof jsonMsg?.toAnsi === "function" ? jsonMsg.toAnsi() : undefined;
      } catch {
        ansi = undefined;
      }

      const plainClean = stripColorCodes(plain);

      // 0) AuthMe / hoş geldin / join — her zaman sunucu (clickable isim olsa bile)
      if (isLikelySystemMessage(plainClean)) {
        this.ingestServerChat(plain, ansi);
        return;
      }

      // A) 1.19+ playerChat: sender UUID → tab list ismi (Paper'da en güvenilir)
      const fromUuid = resolveUsernameFromSender(sender, bot.players as Record<string, { uuid?: string }>);
      // B) component (translate / clickEvent /msg)  C) düz metin regex
      const fromJson = parseChatComponent(jsonMsg);
      const fromPlain = parseChatMessage(plain);

      // JSON açıkça server dediyse
      if (fromJson?.kind === "server" && !fromJson.username) {
        this.ingestServerChat(fromJson.text || plain, ansi);
        return;
      }

      let username = fromUuid ?? fromJson?.username ?? fromPlain.username;
      let text = (fromJson?.text || fromPlain.text || "").trim();
      let kind: "player" | "whisper" | "server" = username
        ? fromJson?.kind === "whisper" || fromPlain.kind === "whisper"
          ? "whisper"
          : "player"
        : "server";

      // UUID ile gelen gerçek playerChat: gövde plain (isim satırda yoksa)
      if (fromUuid && username) {
        if (!fromJson?.username && !fromPlain.username) {
          if (!plainClean.toLowerCase().includes(username.toLowerCase())) {
            text = plainClean;
          }
        }
        // UUID varsa sistem değilse güven — ama gövde hâlâ sistem kalıntısı olabilir
        if (!isValidPlayerChatBody(text || plainClean, plainClean)) {
          this.ingestServerChat(plain, ansi);
          return;
        }
        this.ingestPlayerChat(
          username,
          text || plainClean,
          kind === "whisper" ? "whisper" : "player",
          ansi,
          plain,
          fromPlain.prefix ?? fromJson?.prefix,
          fromPlain.nameSuffix ?? fromJson?.nameSuffix
        );
        return;
      }

      // D) öğrenilmiş isimler — sadece net sohbet gövdesi varsa
      if (!username) {
        for (const known of this.learnedChatUsers) {
          const hit = applyLearnedPrefix(plain, known);
          if (hit?.username && isValidPlayerChatBody(hit.text, plainClean)) {
            username = hit.username;
            text = hit.text;
            kind = "player";
            break;
          }
        }
      }

      if (username && kind !== "server") {
        const cleaned = applyLearnedPrefix(plain, username, text);
        if (cleaned?.text && isValidPlayerChatBody(cleaned.text, plainClean)) text = cleaned.text;
        // plain parse prefix
        if (fromPlain.prefix && fromPlain.username?.toLowerCase() === username.toLowerCase()) {
          /* prefix fromPlain ile gelir */
        }
        const body = (text || plainClean).trim();
        if (!isValidPlayerChatBody(body, plainClean)) {
          this.ingestServerChat(plain, ansi);
          return;
        }
        this.ingestPlayerChat(
          username,
          body,
          kind === "whisper" ? "whisper" : "player",
          ansi,
          plain,
          fromPlain.prefix ?? fromJson?.prefix,
          fromPlain.nameSuffix ?? fromJson?.nameSuffix
        );
        return;
      }

      // sunucu / sistem
      this.ingestServerChat(plain, ansi);
    });
  }

  private ingestServerChat(plain: string, ansi?: string) {
    const key = `s:${stripColorCodes(plain)}`;
    if (!this.noteChatKey(key)) return;
    const entry: ChatEntry = {
      ts: Date.now(),
      botId: this.config.id,
      kind: "server",
      text: plain,
      ansi
    };
    this.pushChat(entry);
    this.emit("chatParsed", entry);
  }

  /**
   * oyuncu sohbeti — rütbe/prefix (satır + tab displayName) + gövde.
   * Paper playerChat çoğu zaman sadece gövde + UUID verir; isim/rütbe tab listesinden gelir.
   */
  private ingestPlayerChat(
    username: string,
    message: string,
    kind: "player" | "whisper",
    ansi?: string,
    fullPlain?: string,
    prefixHint?: string,
    nameSuffixHint?: string
  ) {
    const text = message.trimEnd();
    if (!isValidPlayerChatBody(text, fullPlain ?? `${username}: ${text}`)) return;
    const key = `${kind[0]}:${username.toLowerCase()}:${text}`;
    if (!this.noteChatKey(key)) return;
    this.learnedChatUsers.add(username);
    if (this.learnedChatUsers.size > 200) {
      const first = this.learnedChatUsers.values().next().value;
      if (first) this.learnedChatUsers.delete(first);
    }

    const rawLine = fullPlain ?? text;
    const rawClean = stripColorCodes(rawLine);
    const decor = extractNameDecor(rawClean, username, text);

    // 1) satırdan prefix  2) hint  3) tab listesi displayName (LuckPerms rütbe)
    let prefix = "";
    if (prefixHint?.trim()) {
      prefix = prefixHint.endsWith(" ") ? prefixHint : prefixHint + " ";
    } else if (decor.prefix) {
      prefix = decor.prefix;
    } else {
      // tab list displayName
      try {
        const pl = this.bot?.players?.[username];
        const dn =
          pl?.displayName && typeof (pl.displayName as { toString?: () => string }).toString === "function"
            ? String(pl.displayName)
            : "";
        prefix = prefixFromDisplayName(dn, username);
      } catch {
        prefix = "";
      }
    }

    const nameSuffix = nameSuffixHint || decor.nameSuffix || ": ";
    // gövde: satırda isim yoksa plain tamamen gövdedir (1.19+ playerChat)
    let body = text;
    if (lineIncludesUsername(rawClean, username)) {
      body = decor.body && isValidPlayerChatBody(decor.body) ? decor.body : text;
    } else if (rawClean && rawClean !== username) {
      // UUID chat: plain = sadece mesaj
      body = rawClean;
    }

    const fullText = lineIncludesUsername(rawClean, username)
      ? rawClean
      : `${prefix}${username}${nameSuffix}${body}`.replace(/\s{2,}/g, " ").trim();

    // ANSI: yalnızca tam satır (isim/rütbe içeriyorsa) sakla; yoksa panoda isim kaybolmasın
    const ansiFull = ansi && lineIncludesUsername(ansi, username) ? ansi : undefined;
    // gövde renkleri for ayrı alan yok — text düz; prefix ayrı

    const entry: ChatEntry = {
      ts: Date.now(),
      botId: this.config.id,
      kind,
      username,
      self: username.toLowerCase() === this.config.username.toLowerCase(),
      text: body,
      prefix: prefix || undefined,
      nameSuffix: nameSuffix || ": ",
      fullText,
      ansi: ansiFull
    };
    this.pushChat(entry);
    this.emit("chatParsed", entry);
  }

  private noteChatKey(key: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.recentChatKeys) {
      if (now - t > 2000) this.recentChatKeys.delete(k);
    }
    if (this.recentChatKeys.has(key)) return false;
    this.recentChatKeys.set(key, now);
    return true;
  }

  private teardownBot() {
    if (this.posTimer) {
      clearInterval(this.posTimer);
      this.posTimer = null;
    }
    if (this.invTimer) {
      clearTimeout(this.invTimer);
      this.invTimer = null;
    }
    this.combat.detach();
    this.survival.detach();
    this.build.onDisconnect(); // freeze build state; auto-resume arms if enabled
    if (this.foodWatchTimer) {
      clearInterval(this.foodWatchTimer);
      this.foodWatchTimer = null;
    }
    const bot = this.bot;
    this.bot = null;
    if (bot) {
      try {
        bot.removeAllListeners();
      } catch {
        /* noop */
      }
      // KRİTİK: quit sonrası socket'ten geç gelen 'error' olayları dinleyicisiz
      // kalırsa Node tüm prosesi düşürür (unhandled 'error'). No-op yakalayıcı şart.
      bot.on("error", () => {});
      try {
        const client = (bot as unknown as { _client?: NodeJS.EventEmitter })._client;
        client?.removeAllListeners?.("error");
        client?.on?.("error", () => {});
      } catch {
        /* noop */
      }
    }
  }

  private scheduleReconnect() {
    if (!this.wantsRunning || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt++;
    this.setStatus("reconnecting");
    this.log.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantsRunning) this.connect();
    }, delay);
  }

  // ---- state / emit helpers ---------------------------------------------------

  private setStatus(status: BotStatus) {
    this.status = status;
    this.emit("status", {
      botId: this.config.id,
      status,
      kickReason: this.runtime.kickReason,
      lastError: this.runtime.lastError
    });
  }

  private emitVitals() {
    this.emit("vitals", {
      botId: this.config.id,
      health: this.runtime.health,
      food: this.runtime.food,
      foodSaturation: this.runtime.foodSaturation,
      xpLevel: this.runtime.xpLevel,
      ping: this.runtime.ping
    });
  }

  private updateDimension() {
    const dim = this.bot?.game?.dimension ?? "overworld";
    this.runtime.dimension = String(dim).replace(/^minecraft:/, "");
  }

  private startPositionLoop() {
    if (this.posTimer) clearInterval(this.posTimer);
    this.posTimer = setInterval(() => {
      const bot = this.bot;
      if (!bot?.entity?.position) return;
      const p = bot.entity.position;
      this.runtime.position = { x: round2(p.x), y: round2(p.y), z: round2(p.z) };

      // ping'i ~2 sn'de bir güncelle (ayrı timer açmamak for aynı döngüde)
      if (++this.pingCounter % 8 === 0) {
        const ping = bot.players?.[bot.username]?.ping;
        if (typeof ping === "number" && ping !== this.runtime.ping) {
          this.runtime.ping = ping;
          this.emitVitals();
        }
      }

      const key = `${this.runtime.position.x},${this.runtime.position.y},${this.runtime.position.z},${this.runtime.dimension}`;
      if (key !== this.lastPosKey) {
        this.lastPosKey = key;
        this.emit("position", {
          botId: this.config.id,
          position: this.runtime.position,
          dimension: this.runtime.dimension
        });
      }
      // ~1 Hz nearby (4 × 250ms)
      if (++this.nearbyTick % 4 === 0) this.emitNearby();
    }, POSITION_EMIT_MS);
  }

  // ---- inventory (Faz 5) ---------------------------------------------------------

  private hookInventory(bot: Bot) {
    const push = () => this.scheduleInventorySync();
    bot.inventory.on("updateSlot", push);
    (bot as unknown as NodeJS.EventEmitter).on("heldItemChanged", push);
  }

  /** 150ms debounce: slot güncellemesi patlamalarını tek yayına toplar */
  private scheduleInventorySync() {
    if (this.invTimer) return;
    this.invTimer = setTimeout(() => {
      this.invTimer = null;
      const bot = this.bot;
      if (!bot || this.status !== "online") return;
      try {
        this.lastInventory = snapshotInventory(bot);
      } catch (err) {
        this.log.debug("Could not read inventory", String(err));
        return;
      }
      this.emit("inventory", { botId: this.config.id, inventory: this.lastInventory });

      const used = usedMainSlots(this.lastInventory);
      if (used >= 36 && !this.invWasFull) {
        this.invWasFull = true;
        this.log.warn("Inventory completely full (36/36) — gathering tasks may pause");
        this.emit("inventoryFull", { botId: this.config.id });
      } else if (used < 36 && this.invWasFull) {
        this.invWasFull = false;
      }
    }, 150);
  }

  private loadArmorManager(bot: Bot) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const armorManager = require("mineflayer-armor-manager");
      bot.loadPlugin(armorManager);
      setTimeout(() => {
        try {
          (bot as unknown as { armorManager?: { equipAll(): void } }).armorManager?.equipAll();
        } catch {
          /* zırh yoksa sorun değil */
        }
      }, 2000);
      this.log.debug("armor-manager loaded (auto-equips best armor)");
    } catch (err) {
      this.log.warn("armor-manager failed to load — auto armor disabled", String(err));
    }
  }

  private pushChat(entry: ChatEntry) {
    this.chatHistory.push(entry);
    if (this.chatHistory.length > CHAT_RING_CAP) this.chatHistory.splice(0, this.chatHistory.length - CHAT_RING_CAP);
    this.emit("chat", entry);

    const day = new Date(entry.ts).toISOString().slice(0, 10);
    const file = path.join(CHAT_LOGS_DIR, `chat-${sanitizeFile(this.config.username)}-${day}.jsonl`);
    fs.appendFile(file, JSON.stringify(entry) + "\n", () => {});
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function fmtPos(p: { x: number; y: number; z: number }): string {
  return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
}
function sanitizeFile(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}
function num(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${field}`);
  return n;
}
function str(v: unknown, field: string): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(`Cannot be empty: ${field}`);
  return s;
}
function clampRange(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(16, Math.floor(n)));
}
function numOpt(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
/** tarım aksiyonlarının ortak alan paramları (x/y/z boşsa bot konumu) */
function farmAreaFrom(action: Record<string, unknown>): {
  x?: number;
  y?: number;
  z?: number;
  radius?: number;
  maxBlocks?: number;
} {
  return {
    x: numOpt(action.x),
    y: numOpt(action.y),
    z: numOpt(action.z),
    radius: numOpt(action.radius),
    maxBlocks: numOpt(action.maxBlocks ?? action.max_blocks)
  };
}

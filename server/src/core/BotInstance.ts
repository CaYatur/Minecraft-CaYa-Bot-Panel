import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { createBot, type Bot } from "mineflayer";
import { CHAT_LOGS_DIR } from "../config/paths";
import {
  applyLearnedPrefix,
  isLikelySystemMessage,
  isValidPlayerChatBody,
  parseChatComponent,
  parseChatMessage,
  resolveUsernameFromSender,
  stripColorCodes
} from "../modules/chat/parse";
import { BuildService } from "../modules/build";
import { CombatService } from "../modules/combat";
import { CraftService } from "../modules/craft";
import { GatherService } from "../modules/gather";
import { snapshotInventory, usedMainSlots } from "../modules/inventory";
import { runFollow, runGoto, runGotoPlayer, stopMovement } from "../modules/movement";
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
    private readonly getServer: (id: string) => ServerProfile | undefined
  ) {
    super();
    this.log = createLogger("bot", config.id);
    this.combat = new CombatService(this);
    this.survival = new SurvivalService(this);
    this.gather = new GatherService(this);
    this.craft = new CraftService(this);
    this.build = new BuildService(this);
    this.limiter = new ChatRateLimiter(
      (text) => {
        if (this.bot && this.status === "online") {
          this.bot.chat(text);
          this.log.debug(`Sohbete gönderildi: ${text}`);
        } else {
          this.log.warn("Bot çevrimdışı — sohbet mesajı gönderilemedi", text);
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
      this.log.success(`Görev tamamlandı: ${s.label}`);
      this.emit("taskEvent", { botId: this.config.id, kind: "done" as const, taskType: s.type, label: s.label });
    });
    this.tasks.on("taskFailed", (s: TaskSummary, err: string) => {
      this.log.error(`Görev başarısız: ${s.label}`, err);
      this.emit("taskEvent", { botId: this.config.id, kind: "failed" as const, taskType: s.type, label: s.label });
    });
  }

  /** Menzildeki oyuncular (entity varsa mesafe; yoksa tab-only). */
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
    // tab isimleri join/leave için
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
    this.log.info("Bot durduruldu");
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

  /** modules (combat vb.) için paylaşılan logger — sohbete asla yazmaz (İ1) */
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
      case "goto-player": {
        const player = str(action.player, "player");
        const range = clampRange(action.range ?? 2);
        return this.tasks.enqueue(
          { type, label: `oyuncuya git: ${player}`, priority: PRIORITY.USER, params: { player, range } },
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
        this.combat.clearCompanion("kullanıcı stop");
        this.log.info("Hareket ve görev kuyruğu durduruldu (kullanıcı)");
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
        this.combat.setProtect(str(action.player, "player"), enabled, {
          followDistance: action.followDistance != null ? Number(action.followDistance) : undefined,
          range: action.range != null ? Number(action.range) : undefined,
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
      case "chat": {
        const text = str(action.text, "text");
        this.sendChat(text);
        return null;
      }
      // ---- Faz 6 dövüş --------------------------------------------------------
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
        return this.gather.enqueueCollectWood(Number(action.count ?? 16), action.logType ? String(action.logType) : undefined);
      case "collect-drops":
      case "eşya-topla":
        return this.gather.enqueueCollectDrops(action.filter ? String(action.filter) : undefined, Number(action.radius ?? 16));
      case "mine":
      case "maden-topla":
        return this.gather.enqueueMine(String(action.ore ?? "iron"), Number(action.count ?? 8), action.mode === "utility" ? "utility" : "legit");
      // ---- Faz 9 craft ---------------------------------------------------------
      case "craft":
      case "üret":
        return this.craft.enqueueCraft(String(action.item ?? action.name ?? ""), Number(action.count ?? 1));
      // ---- Faz 10 depo ---------------------------------------------------------
      case "deposit":
      case "depoya-bırak":
        return this.enqueueDeposit(String(action.filter ?? ""));
      case "withdraw":
      case "depodan-al":
        return this.enqueueWithdraw(String(action.item ?? ""), Number(action.count ?? 1));
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
          versionHint,
          rotateY: action.rotateY != null ? Number(action.rotateY) : 0,
          mirrorX: action.mirrorX === true || action.mirrorX === "true",
          mirrorZ: action.mirrorZ === true || action.mirrorZ === "true"
        });
      }
      case "stop-build":
        this.build.stopBuild("panel");
        return null;
      default:
        throw new Error(`Bilinmeyen aksiyon tipi: ${type || "(boş)"}`);
    }
  }

  private enqueueDeposit(filter: string) {
    return this.tasks.enqueue(
      { type: "deposit", label: `depoya bırak${filter ? `: ${filter}` : ""}`, priority: PRIORITY.USER, params: { filter }, requeueOnPreempt: true },
      () => async (token, report) => {
        const bot = this.bot;
        if (!bot || this.status !== "online") throw new Error("Bot çevrimdışı");
        report({ done: 0, total: 1, label: "sandık aranıyor" });
        const chest = bot.findBlock({ matching: (b) => b.name === "chest" || b.name === "trapped_chest" || b.name === "barrel", maxDistance: 32 });
        if (!chest) throw new Error("Yakında sandık yok — önce sandık açarak world-memory'ye kaydedin");
        await runGoto(this, chest.position.x, chest.position.y, chest.position.z, 2, token, report);
        if (token.cancelled) throw new Error(token.reason ?? "iptal");
        const win = await bot.openContainer(chest);
        const keep = this.config.inventory.keepItems;
        const items = bot.inventory.items().filter((i) => !keep.includes(i.name) && (!filter || i.name.includes(filter)));
        for (const it of items) {
          if (token.cancelled) break;
          try {
            // chest window deposit API varies — best-effort
            const w = win as unknown as { deposit?: (t: number, m: null, c: number) => Promise<void>; close: () => void; containerItems?: () => Array<{ name: string; count: number }> };
            if (w.deposit) await w.deposit(it.type, null, it.count);
          } catch {
            /* full */
          }
        }
        const w2 = win as unknown as { containerItems?: () => Array<{ name: string; count: number }>; close: () => void };
        this.emit("chestOpened", {
          serverId: this.config.serverId,
          x: chest.position.x,
          y: chest.position.y,
          z: chest.position.z,
          dimension: this.runtime.dimension,
          items: w2.containerItems?.().map((i) => ({ name: i.name, count: i.count })) ?? []
        });
        win.close();
        report({ done: 1, total: 1, label: "depozito bitti" });
      }
    );
  }

  private enqueueWithdraw(item: string, count: number) {
    return this.tasks.enqueue(
      { type: "withdraw", label: `depodan al: ${item}×${count}`, priority: PRIORITY.USER, params: { item, count }, requeueOnPreempt: true },
      () => async (token, report) => {
        const bot = this.bot;
        if (!bot || this.status !== "online") throw new Error("Bot çevrimdışı");
        report({ done: 0, total: 1, label: "sandık" });
        const chest = bot.findBlock({ matching: (b) => b.name === "chest" || b.name === "barrel", maxDistance: 32 });
        if (!chest) throw new Error("Yakında sandık yok");
        await runGoto(this, chest.position.x, chest.position.y, chest.position.z, 2, token, report);
        const win = await bot.openContainer(chest);
        try {
          const id = bot.registry.itemsByName[item]?.id;
          if (id == null) throw new Error(`Eşya yok: ${item}`);
          const w = win as unknown as { withdraw?: (t: number, m: null, c: number) => Promise<void> };
          if (w.withdraw) await w.withdraw(id, null, count);
          else throw new Error("Sandık withdraw API yok");
        } finally {
          win.close();
        }
        report({ done: 1, total: 1, label: "alındı" });
      }
    );
  }

  private enqueueFetch(item: string, count: number, player: string) {
    return this.tasks.enqueue(
      { type: "fetch", label: `getir: ${item}×${count} → ${player || "?"}`, priority: PRIORITY.USER, params: { item, count, player }, requeueOnPreempt: true },
      () => async (token, report) => {
        report({ done: 0, total: 3, label: "temin" });
        const bot = this.bot;
        if (!bot || this.status !== "online") throw new Error("Bot çevrimdışı");
        // Nested enqueue beklemez — elde varsa devam; yoksa net hata (kullanıcı önce mine/craft/withdraw yapsın)
        const have = bot.inventory.items().filter((i) => i.name.includes(item)).reduce((s, i) => s + i.count, 0);
        if (have < count) {
          throw new Error(
            `Envanterde ${item} yetersiz (${have}/${count}). Önce depodan-al / maden / üret, sonra getir.`
          );
        }
        if (token.cancelled) throw new Error(token.reason ?? "iptal");
        report({ done: 1, total: 3, label: "oyuncuya git" });
        if (player) {
          await runGotoPlayer(this, player, 2, token, report);
        } else {
          throw new Error("Getir için hedef oyuncu adı gerekli");
        }
        report({ done: 2, total: 3, label: "bırak" });
        const stack = bot.inventory.items().find((i) => i.name.includes(item));
        if (!stack) throw new Error(`Eşya kayboldu: ${item}`);
        try {
          await bot.toss(stack.type, null, Math.min(count, stack.count));
        } catch (e) {
          throw new Error(`Toss başarısız: ${e instanceof Error ? e.message : e}`);
        }
        report({ done: 3, total: 3, label: "getir bitti" });
      }
    );
  }

  // ---- connection -----------------------------------------------------------

  private connect() {
    const server = this.getServer(this.config.serverId);
    if (!server) {
      this.runtime.lastError = "Sunucu profili bulunamadı — bot bir sunucuya bağlanamıyor.";
      this.log.error(this.runtime.lastError);
      this.setStatus("error");
      return;
    }

    this.setStatus("connecting");
    this.log.info(`Bağlanılıyor: ${server.host}:${server.port} (sürüm: ${server.version})`);

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
      this.log.error("Bağlantı başlatılamadı", msg);
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
      this.log.info("Sunucuya giriş yapıldı, spawn bekleniyor…");
    });

    let invHooked = false; // spawn her respawn'da tetiklenir — kancalar bot başına BİR kez
    bot.on("spawn", () => {
      this.reconnectAttempt = 0;
      this.runtime.kickReason = undefined;
      this.runtime.lastError = undefined;
      this.updateDimension();
      this.setStatus("online");
      this.log.success("Bot dünyaya girdi (spawn)");
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
      }
      this.scheduleInventorySync(); // respawn sonrası tam resync (TODO §12)
      this.emit("spawned", { botId: this.config.id });
      // yakındaki oyuncular paneli hemen dolsun
      setTimeout(() => this.emitNearby(true), 500);
    });

    bot.on("respawn", () => {
      this.updateDimension();
      this.log.info("Yeniden doğuldu / boyut değişti");
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
      this.log.warn("Bot öldü", `Konum: ${fmtPos(this.runtime.position)}`);
    });

    bot.on("kicked", (reason: unknown) => {
      const text = chatComponentToText(reason) || String(reason);
      this.runtime.kickReason = text;
      this.log.error("Sunucudan atıldı (kick)", text);
      this.setStatus("kicked");
      // premium-doğrulama kick'inde tekrar denemek anlamsız
      if (text.includes("premium doğrulama")) {
        this.wantsRunning = false;
      }
    });

    bot.on("error", (err: Error) => {
      const msg = friendlyError(err);
      this.runtime.lastError = msg;
      this.log.error("Bağlantı hatası", msg);
      if (this.status !== "kicked") this.setStatus("error");
      this.scheduleReconnect();
    });

    bot.on("end", (reason: string) => {
      this.log.info(`Bağlantı kapandı (${reason || "bilinmiyor"})`);
      if (this.tasks.currentSummary) {
        this.log.warn("Bağlantı koptuğu için aktif görevler iptal edildi (görev kalıcılığı: Faz 10)");
      }
      this.tasks.cancelAll("bağlantı koptu");
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
     * Dedup: aynı oyuncu+metin 2 sn içinde iki kez yazılmaz.
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
      this.ingestPlayerChat(username, msg, "player");
    });
    bot.on("whisper", (username: string, message: string) => {
      if (!username || message == null) return;
      const msg = String(message);
      if (!isValidPlayerChatBody(msg, msg)) return;
      this.ingestPlayerChat(username, msg, "whisper");
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

      // 0) AuthMe / hoş geldin / join — her zaman sunucu (tıklanabilir isim olsa bile)
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
        this.ingestPlayerChat(username, text || plainClean, kind === "whisper" ? "whisper" : "player", ansi);
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
        const body = (text || plainClean).trim();
        if (!isValidPlayerChatBody(body, plainClean)) {
          this.ingestServerChat(plain, ansi);
          return;
        }
        this.ingestPlayerChat(username, body, kind === "whisper" ? "whisper" : "player", ansi);
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

  /** oyuncu sohbetini tek kanaldan yaz (dedup + öğrenme) */
  private ingestPlayerChat(username: string, message: string, kind: "player" | "whisper", ansi?: string) {
    const text = message.trimEnd();
    if (!isValidPlayerChatBody(text, `${username}: ${text}`)) return;
    const key = `${kind[0]}:${username.toLowerCase()}:${text}`;
    if (!this.noteChatKey(key)) return;
    this.learnedChatUsers.add(username);
    // set sınırla
    if (this.learnedChatUsers.size > 200) {
      const first = this.learnedChatUsers.values().next().value;
      if (first) this.learnedChatUsers.delete(first);
    }
    const entry: ChatEntry = {
      ts: Date.now(),
      botId: this.config.id,
      kind,
      username,
      self: username.toLowerCase() === this.config.username.toLowerCase(),
      text,
      ansi
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
    this.log.info(`Yeniden bağlanma ${Math.round(delay / 1000)} sn sonra (deneme ${this.reconnectAttempt})`);
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

      // ping'i ~2 sn'de bir güncelle (ayrı timer açmamak için aynı döngüde)
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

  // ---- envanter (Faz 5) ---------------------------------------------------------

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
        this.log.debug("Envanter okunamadı", String(err));
        return;
      }
      this.emit("inventory", { botId: this.config.id, inventory: this.lastInventory });

      const used = usedMainSlots(this.lastInventory);
      if (used >= 36 && !this.invWasFull) {
        this.invWasFull = true;
        this.log.warn("Envanter tamamen doldu (36/36) — toplama görevleri duraklayabilir");
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
      this.log.debug("armor-manager yüklendi (en iyi zırhı otomatik giyer)");
    } catch (err) {
      this.log.warn("armor-manager yüklenemedi — otomatik zırh devre dışı", String(err));
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
  if (!Number.isFinite(n)) throw new Error(`Geçersiz sayı: ${field}`);
  return n;
}
function str(v: unknown, field: string): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(`Boş olamaz: ${field}`);
  return s;
}
function clampRange(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(16, Math.floor(n)));
}

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { createBot, type Bot } from "mineflayer";
import { CHAT_LOGS_DIR } from "../config/paths";
import { parseChatMessage } from "../modules/chat/parse";
import { runFollow, runGoto, runGotoPlayer, stopMovement } from "../modules/movement";
import type { BotConfig, BotRuntimeState, BotSnapshot, BotStatus, ChatEntry, ServerProfile, TaskSummary } from "../types";
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
  private wantsRunning = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private posTimer: NodeJS.Timeout | null = null;
  private lastPosKey = "";
  private pingCounter = 0;
  private readonly limiter: ChatRateLimiter;
  private readonly log: BotLogger;

  constructor(
    public config: BotConfig,
    private readonly getServer: (id: string) => ServerProfile | undefined
  ) {
    super();
    this.log = createLogger("bot", config.id);
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
    this.tasks.on("taskDone", (s: TaskSummary) => this.log.success(`Görev tamamlandı: ${s.label}`));
    this.tasks.on("taskFailed", (s: TaskSummary, err: string) => this.log.error(`Görev başarısız: ${s.label}`, err));
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

  getSnapshot(): BotSnapshot {
    return {
      config: this.config,
      status: this.status,
      runtime: this.runtime,
      chatQueueLength: this.limiter.length,
      tasks: { current: this.tasks.currentSummary, queue: this.tasks.queueSummaries }
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
        const player = str(action.player, "player");
        const distance = clampRange(action.distance ?? 3);
        return this.tasks.enqueue(
          { type, label: `takip: ${player} (iptale dek)`, priority: PRIORITY.USER, params: { player, distance } },
          () => (token, report) => runFollow(this, player, distance, token, report)
        );
      }
      case "stop":
        stopMovement(this);
        this.log.info("Hareket ve görev kuyruğu durduruldu (kullanıcı)");
        return null;
      case "chat": {
        const text = str(action.text, "text");
        this.sendChat(text);
        return null;
      }
      default:
        throw new Error(`Bilinmeyen aksiyon tipi: ${type || "(boş)"}`);
    }
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

    bot.on("spawn", () => {
      this.reconnectAttempt = 0;
      this.runtime.kickReason = undefined;
      this.runtime.lastError = undefined;
      this.updateDimension();
      this.setStatus("online");
      this.log.success("Bot dünyaya girdi (spawn)");
      this.emitVitals();
      this.startPositionLoop();
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

    // All incoming chat/system messages (Faz 3). "game_info" = actionbar spam, skipped.
    bot.on("message", (jsonMsg: any, position: string) => {
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
      const parsed = parseChatMessage(plain);
      const entry: ChatEntry = {
        ts: Date.now(),
        botId: this.config.id,
        kind: parsed.kind,
        username: parsed.username,
        self: parsed.username != null && parsed.username.toLowerCase() === this.config.username.toLowerCase(),
        text: parsed.kind === "server" ? plain : parsed.text,
        ansi
      };
      this.pushChat(entry);
    });
  }

  private teardownBot() {
    if (this.posTimer) {
      clearInterval(this.posTimer);
      this.posTimer = null;
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
    }, POSITION_EMIT_MS);
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

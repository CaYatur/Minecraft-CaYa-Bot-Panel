import { EventEmitter } from "events";
import { accounts } from "../modules/auth/accounts";
import { bridgeFromMinecraft, connectDiscord, disconnectDiscord, noteHealth, notifyDiscord, setDiscordControl } from "../modules/discord/hub";
import { loginSendMode, normalizeLoginTemplate } from "../modules/alwaysOn/loginPrompt";
import { deleteLoginSecret } from "../modules/alwaysOn/secrets";
import { stopAllViews, stopView } from "../modules/view/session";
import { AUTH_ERRORS, type AuthErrorCode } from "../modules/auth/messages";
import { RuleEngine } from "../modules/automation/RuleEngine";
import { WorldMemory } from "../modules/world/memory";
import { loadJson, saveJson } from "../persistence/store";
import type { BotAuthType, BotConfig, ServerProfile, StateSnapshot, Waypoint } from "../types";
import { USERNAME_RE, defaultBotConfig, mergeConfig, newId } from "../types";
import { createLogger } from "../utils/logger";
import { BotInstance } from "./BotInstance";
import { PanelError } from "./errors";
import { WaypointStore } from "./Waypoints";

// geriye dönük uyumluluk: PanelError eskiden bu dosyadaydı, mevcut import'lar bozulmasın
export { PanelError };

const BOTS_FILE = "bots.json";
const SERVERS_FILE = "servers.json";
const BULK_START_STAGGER_MS = 2_000; // stagger bulk starts to avoid flooding the server (Faz 2)

export interface CreateBotInput {
  username: string;
  serverId: string;
  autostart?: boolean;
  auth?: BotAuthType;
  accountId?: string | null;
}

/**
 * Owns every BotInstance + the server profiles. Emits "botAdded"|"botRemoved"
 * (with the instance) so the socket layer can wire live events per bot.
 */
export class BotManager extends EventEmitter {
  readonly bots = new Map<string, BotInstance>();
  readonly waypoints = new WaypointStore();
  readonly worldMemory = new WorldMemory();
  readonly rules = new RuleEngine(this);
  servers: ServerProfile[] = [];
  private readonly log = createLogger("manager");

  boot() {
    this.waypoints.load();
    this.worldMemory.load();
    this.rules.load();
    accounts.load();
    accounts.on("updated", () => this.emit("changed"));
    accounts.on("profile", (info: { accountId: string; username: string }) => {
      this.applyPremiumUsername(info.accountId, info.username);
    });
    accounts.on("removed", (info: { accountId: string }) => {
      for (const inst of this.bots.values()) {
        if (inst.config.accountId !== info.accountId) continue;
        inst.config.accountId = null;
        inst.config.auth = "offline";
      }
      this.persistBots();
    });
    accounts.on("cancelled", (info: { accountId: string; botId?: string }) => {
      const inst = info.botId ? this.bots.get(info.botId) : undefined;
      if (inst && inst.config.accountId === info.accountId && inst.status === "connecting") inst.stop();
    });
    this.servers = loadJson<ServerProfile[]>(SERVERS_FILE, []);
    const configs = loadJson<BotConfig[]>(BOTS_FILE, []);
    const needsAuthMigration = configs.some((cfg) => cfg.auth == null || !("accountId" in cfg));
    for (const cfg of configs) this.instantiate(cfg);
    if (needsAuthMigration) this.persistBots();
    this.log.info(`${this.servers.length} server profiles, ${configs.length} bot configs loaded`);

    setDiscordControl({
      list: () => [...this.bots.values()].map((bot) => ({ id: bot.config.id, username: bot.config.username, status: bot.status })),
      start: (username) => {
        const inst = this.botByUsername(username);
        this.startBot(inst.config.id);
        return `Starting ${inst.config.username}.`;
      },
      stop: (username) => {
        const inst = this.botByUsername(username);
        this.stopBot(inst.config.id);
        return `Stopping ${inst.config.username}.`;
      },
      say: (username, text) => {
        const inst = this.botByUsername(username);
        inst.sendChat(text);
        return `Sent.`;
      },
      status: (username) => {
        const inst = this.botByUsername(username);
        const up = inst.alwaysOnStatus();
        return `${inst.config.username} is ${inst.status}. Uptime ${Math.round(up.uptime.currentMs / 1000)}s. Always-on ${inst.config.alwaysOn?.enabled ? "on" : "off"}.`;
      }
    });
    void connectDiscord();
    const autostart = [...this.bots.values()].filter((b) => b.config.autostart);
    if (autostart.length > 0) {
      this.log.info(`${autostart.length} bot(s) marked autostart — starting gradually (I4)`);
      this.startStaggered(autostart.map((b) => b.config.id));
    }
  }

  // ---- servers ---------------------------------------------------------------

  createServer(input: Omit<ServerProfile, "id">): ServerProfile {
    const profile: ServerProfile = {
      id: newId(),
      name: String(input.name || "").trim() || `${input.host}:${input.port}`,
      host: String(input.host || "").trim(),
      port: clampPort(input.port),
      version: normalizeVersion(input.version),
      note: input.note
    };
    if (!profile.host) throw new PanelError("Server host cannot be empty.");
    this.servers.push(profile);
    void saveJson(SERVERS_FILE, this.servers);
    this.log.success(`Server profile added: ${profile.name} (${profile.host}:${profile.port})`);
    this.emit("changed");
    return profile;
  }

  updateServer(id: string, patch: Partial<Omit<ServerProfile, "id">>): ServerProfile {
    const profile = this.servers.find((s) => s.id === id);
    if (!profile) throw new PanelError("Server profile not found.", 404);
    if (patch.host !== undefined) profile.host = String(patch.host).trim();
    if (patch.port !== undefined) profile.port = clampPort(patch.port);
    if (patch.version !== undefined) profile.version = normalizeVersion(patch.version);
    if (patch.name !== undefined) profile.name = String(patch.name).trim() || profile.name;
    if (patch.note !== undefined) profile.note = patch.note;
    void saveJson(SERVERS_FILE, this.servers);
    this.emit("changed");
    return profile;
  }

  deleteServer(id: string) {
    const inUse = [...this.bots.values()].filter((b) => b.config.serverId === id);
    if (inUse.length > 0) {
      throw new PanelError(`This profile is used by ${inUse.length} bot(s) — delete or move them first.`, 409);
    }
    const before = this.servers.length;
    this.servers = this.servers.filter((s) => s.id !== id);
    if (this.servers.length === before) throw new PanelError("Server profile not found.", 404);
    void saveJson(SERVERS_FILE, this.servers);
    this.emit("changed");
  }

  getServer(id: string): ServerProfile | undefined {
    return this.servers.find((s) => s.id === id);
  }

  // ---- bots -----------------------------------------------------------------

  createBot(input: CreateBotInput): BotInstance {
    const username = String(input.username || "").trim();
    this.assertValidNewBot(username, input.serverId);
    const cfg = defaultBotConfig(username, input.serverId);
    cfg.autostart = Boolean(input.autostart);
    this.applyAuth(cfg, input.auth, input.accountId, username);
    const instance = this.instantiate(cfg);
    this.persistBots();
    this.log.success(`Bot created: ${username}`);
    this.emit("botAdded", instance);
    return instance;
  }

  /**
   * Bulk create with a name template. "CaYa_{n}" → CaYa_1..N. If the template
   * has no {n} and count>1, "_{n}" is appended. Collisions advance n (offline
   * modda isim = kimlik; aynı isim aynı sunucuya iki kez giremez — TODO §12).
   */
  bulkCreate(template: string, count: number, serverId: string, autostart = false): BotInstance[] {
    const tpl = template.includes("{n}") ? template : count > 1 ? `${template}_{n}` : template;
    const created: BotInstance[] = [];
    let n = 1;
    let made = 0;
    let guard = 0;
    while (made < count && guard < count * 50) {
      guard++;
      const name = tpl.replace("{n}", String(n++));
      try {
        this.assertValidNewBot(name, serverId);
      } catch {
        continue; // name conflict → next number
      }
      const cfg = defaultBotConfig(name, serverId);
      cfg.autostart = autostart;
      const inst = this.instantiate(cfg);
      created.push(inst);
      this.emit("botAdded", inst);
      made++;
    }
    this.persistBots();
    this.log.success(`${created.length} bots created (template: ${tpl})`);
    return created;
  }

  updateBotConfig(id: string, patch: Partial<BotConfig>): BotInstance {
    const inst = this.mustGet(id);
    // id/serverId/username değişimi ayrı ele alınır; patch'ten ayıkla
    const { id: _ignore, username, serverId, ...rest } = patch;
    const unsafe = rest as Partial<BotConfig> & { password?: unknown; token?: unknown; webhookUrl?: unknown };
    delete unsafe.password;
    delete unsafe.token;
    delete unsafe.webhookUrl;
    if (unsafe.alwaysOn?.loginPlugin && "password" in unsafe.alwaysOn.loginPlugin) {
      delete (unsafe.alwaysOn.loginPlugin as { password?: unknown }).password;
    }
    if (unsafe.alwaysOn?.loginPlugin) {
      const plugin = unsafe.alwaysOn.loginPlugin;
      try {
        if (plugin.loginTemplate !== undefined) plugin.loginTemplate = normalizeLoginTemplate(plugin.loginTemplate);
        if (plugin.registerTemplate !== undefined) plugin.registerTemplate = normalizeLoginTemplate(plugin.registerTemplate);
        if (plugin.sendMode !== undefined) plugin.sendMode = loginSendMode(plugin.sendMode);
      } catch (err) {
        throw new PanelError(err instanceof Error ? err.message : String(err), 400);
      }
    }
    if (username !== undefined && username !== inst.config.username) {
      const name = String(username).trim();
      this.assertValidNewBot(name, serverId ?? inst.config.serverId, id);
      inst.config.username = name;
      if (inst.status !== "stopped") this.log.warn("Username changed — restart the bot for it to take effect", name);
    }
    if (serverId !== undefined && serverId !== inst.config.serverId) {
      if (!this.getServer(serverId)) throw new PanelError("Target server profile not found.", 404);
      inst.config.serverId = serverId;
      if (inst.status !== "stopped") this.log.warn("Server changed — restart the bot for it to take effect");
    }
    inst.config = mergeConfig(inst.config, rest as Partial<BotConfig>);
    if (patch.alwaysOn) inst.syncAntiAfk();
    if (patch.auth !== undefined || patch.accountId !== undefined) {
      this.applyAuth(inst.config, inst.config.auth, inst.config.accountId, inst.config.username, id);
    }
    this.persistBots();
    this.emit("changed");
    return inst;
  }

  removeBot(id: string) {
    const inst = this.mustGet(id);
    inst.dispose();
    deleteLoginSecret(id);
    void stopView(id);
    this.bots.delete(id);
    this.persistBots();
    this.log.info(`Bot deleted: ${inst.config.username}`);
    this.emit("botRemoved", id);
  }

  startBot(id: string, socketId?: string) {
    const inst = this.mustGet(id);
    this.assertAccountFree(inst);
    inst.start(socketId);
  }

  stopBot(id: string) {
    this.rules.cancelRunsForBot(id, "bot durduruldu", 0);
    this.mustGet(id).stop();
  }

  /**
   * Bot bağlı kalırken gerçekten HER işi durdurur: görev kuyruğu, pathfinder,
   * build/combat yardımcıları ve o bot for çalışan otomasyon akışları.
   */
  cancelAllWork(id: string, reason = "all cancelled from panel") {
    const inst = this.mustGet(id);
    this.rules.cancelRunsForBot(id, reason, 5_000);
    inst.resetAllWork(reason);
  }

  /** staggered start to avoid connection-flood kicks (Faz 2) */
  startStaggered(ids?: string[]) {
    const targets = (ids ?? [...this.bots.keys()]).map((id) => this.bots.get(id)).filter(isDefined);
    targets.forEach((inst, i) => {
      setTimeout(() => {
        if (!this.bots.has(inst.config.id)) return;
        try {
          this.assertAccountFree(inst);
          inst.start();
        } catch (err) {
          inst.runtime.lastError = err instanceof Error ? err.message : String(err);
          inst.runtime.errorCode = "auth.failed";
          this.log.warn(`Could not start ${inst.config.username}`, inst.runtime.lastError);
          this.emit("changed");
        }
      }, i * BULK_START_STAGGER_MS);
    });
    return targets.length;
  }

  stopAll(ids?: string[]) {
    const targets = (ids ?? [...this.bots.keys()]).map((id) => this.bots.get(id)).filter(isDefined);
    for (const t of targets) {
      this.rules.cancelRunsForBot(t.config.id, "botlar topluca durduruldu", 0);
      t.stop();
    }
    return targets.length;
  }

  get(id: string): BotInstance | undefined {
    return this.bots.get(id);
  }

  mustGet(id: string): BotInstance {
    const inst = this.bots.get(id);
    if (!inst) throw new PanelError("Bot not found.", 404);
    return inst;
  }

  snapshot(supportedVersions: string[]): StateSnapshot {
    const waypoints: Record<string, Waypoint[]> = {};
    for (const s of this.servers) {
      const list = this.waypoints.forServer(s.id);
      if (list.length > 0) waypoints[s.id] = list;
    }
    return {
      servers: this.servers,
      bots: [...this.bots.values()].map((b) => b.getSnapshot()),
      waypoints,
      supportedVersions,
      rules: this.rules.list(),
      worldMemory: {
        chests: this.servers.flatMap((s) => this.worldMemory.chestsFor(s.id)),
        ores: this.servers.flatMap((s) => this.worldMemory.oresFor(s.id))
      },
      accounts: accounts.publicView(
        [...this.bots.values()].map((bot) => ({
          id: bot.config.id,
          username: bot.config.username,
          accountId: bot.config.accountId
        }))
      )
    };
  }

  /** Unregister a remembered chest (does not break the in-world block). */
  forgetChest(chestId: string, botId?: string) {
    const row = this.worldMemory.removeChest(chestId);
    if (!row) throw new PanelError("Chest not found in world memory.", 404);
    if (botId) {
      const inst = this.mustGet(botId);
      if (inst.config.serverId !== row.serverId) {
        throw new PanelError("This chest belongs to a different server profile.", 400);
      }
    }
    for (const bot of this.bots.values()) {
      if (bot.config.serverId !== row.serverId) continue;
      try {
        bot.build.stock.remove(row.x, row.y, row.z, row.dimension);
      } catch {
        /* stock ledger is optional */
      }
    }
    this.emit("changed");
    return row;
  }

  // ---- waypoints (değişiklikler "changed" ile panellere yayınlanır) -------------

  createWaypoint(serverId: string, input: { name: string; x: number; y: number; z: number; dimension?: string; note?: string }): Waypoint {
    if (!this.getServer(serverId)) throw new PanelError("Server profile not found.", 404);
    const wp = this.waypoints.create(serverId, input);
    this.log.success(`Waypoint saved: ${wp.name} (${wp.x}, ${wp.y}, ${wp.z})`);
    this.emit("changed");
    return wp;
  }

  deleteWaypoint(id: string) {
    this.waypoints.delete(id);
    this.emit("changed");
  }

  shutdown() {
    void disconnectDiscord();
    void stopAllViews();
    for (const bot of this.bots.values()) {
      try {
        bot.stop();
      } catch {
        /* shutting down */
      }
    }
  }

  // ---- internals --------------------------------------------------------------

  private instantiate(cfg: BotConfig): BotInstance {
    // eski bots.json şema eksiklerini varsayılanlarla doldur (migrasyon)
    const merged = mergeConfig(defaultBotConfig(cfg.username || "bot", cfg.serverId || ""), cfg);
    merged.id = cfg.id || merged.id;
    merged.username = cfg.username || merged.username;
    merged.serverId = cfg.serverId || merged.serverId;
    const inst = new BotInstance(
      merged,
      (sid) => this.getServer(sid),
      (sid) => this.worldMemory.chestsFor(sid),
      {
        prepare: (accountId) => {
          accounts.prepareCache(accountId);
          return {
            cacheKey: accounts.cacheKey(accountId),
            profilesFolder: accounts.cacheDir(accountId),
            hasCache: accounts.hasCache(accountId)
          };
        },
        publishCode: (accountId, code, socketId, botId) => {
          accounts.publishBotCode(accountId, code, socketId, botId);
        },
        rememberProfile: (accountId, profile) => {
          accounts.rememberProfile(accountId, { id: profile.uuid, name: profile.name });
        },
        noteError: (accountId, code) => {
          if (code in AUTH_ERRORS) accounts.noteError(accountId, code as AuthErrorCode);
        },
        seal: (accountId) => accounts.seal(accountId),
        markJoining: (accountId) => accounts.markJoining(accountId),
        finishPrompt: (accountId, result) => accounts.finishPrompt(accountId, result)
      }
    );
    // Faz 6: ölüm konumu → sunucu bazlı "death-<bot>" waypoint (loot for)
    inst.on(
      "deathAt",
      (info: {
        botId?: string;
        username: string;
        serverId: string;
        x: number;
        y: number;
        z: number;
        dimension: string;
        ts: number;
      }) => {
        try {
          const name = `death-${info.username}`;
          const existing = this.waypoints.forServer(info.serverId).find((w) => w.name.toLowerCase() === name.toLowerCase());
          if (existing) {
            try {
              this.waypoints.delete(existing.id);
            } catch {
              /* ignore */
            }
          }
          this.createWaypoint(info.serverId, {
            name,
            x: info.x,
            y: info.y,
            z: info.z,
            dimension: info.dimension,
            note: `Auto death point ${new Date(info.ts).toISOString()}`
          });
        } catch (err) {
          this.log.warn("Could not write death waypoint", err instanceof Error ? err.message : String(err));
        }
        if (info.botId) this.rules.onBotEvent(info.botId, "died");
        notifyDiscord(info.username, "death", `Died at ${info.x}, ${info.y}, ${info.z}`);
      }
    );
    inst.on(
      "chatParsed",
      (entry: { botId: string; username?: string; text: string; kind: string; self?: boolean }) => {
        // Bot's own chat echo must never fire automations (self-trigger loops).
        if (entry.self) return;
        const me = inst.config.username?.toLowerCase();
        if (entry.username && me && entry.username.toLowerCase() === me) return;
        if (entry.kind === "player" || entry.kind === "whisper") {
          this.rules.onChat(entry.botId, entry.username, entry.text);
        }
        bridgeFromMinecraft({
          botId: entry.botId,
          botName: inst.config.username,
          username: entry.username,
          text: entry.text,
          self: entry.self,
          kind: entry.kind
        });
      }
    );
    inst.on("loginState", () => this.persistBots());
    inst.on("spawned", (p: { botId: string }) => {
      this.rules.onBotEvent(p.botId, "spawned");
      if (inst.alwaysOnStatus().reconnect.attempt > 0) notifyDiscord(inst.config.username, "reconnect", "Back online");
    });
    inst.on("status", (p: { status: string; kickReason?: string }) => {
      if (p.status === "kicked" || p.status === "error") {
        notifyDiscord(inst.config.username, "disconnect", p.kickReason || p.status);
      }
    });
    inst.on("vitals", (p: { botId: string; health: number; food: number }) => {
      this.rules.onVitals(p.botId, p.health, p.food);
      noteHealth(p.botId, inst.config.username, p.health);
    });
    inst.on("attacked", (p: { botId: string; attacker?: string; source: "mob" | "player" }) => {
      this.rules.onAttacked(p.botId, p.attacker, p.source);
    });
    inst.on("nearby", (p: { botId: string; players: Array<{ username: string; distance: number | null }> }) => {
      const withDist = p.players
        .filter((x) => x.distance != null)
        .map((x) => ({ username: x.username, distance: x.distance as number }));
      if (withDist.length) this.rules.onNearby(p.botId, withDist);
    });
    inst.on("tabPlayers", (p: { botId: string; names: string[] }) => this.rules.onTabPlayers(p.botId, p.names));
    inst.on("inventoryFull", (p: { botId: string }) => this.rules.onInventoryFull(p.botId));
    inst.on(
      "taskEvent",
      (p: {
        botId: string;
        kind: "done" | "failed";
        taskId: string;
        taskType: string;
        label: string;
        state: string;
        error?: string;
        progress?: { done: number; total: number; label?: string };
      }) => {
        notifyDiscord(inst.config.username, p.kind === "done" ? "taskDone" : "taskFailed", `${p.label}${p.error ? `: ${p.error}` : ""}`);
        this.rules.onTaskEvent(p.botId, p.kind, p.taskType, p.label, {
          taskId: p.taskId,
          state: p.state,
          error: p.error,
          progress: p.progress
        });
      }
    );
    inst.on(
      "chestOpened",
      (info: {
        serverId: string;
        x: number;
        y: number;
        z: number;
        dimension: string;
        items: { name: string; count: number }[];
      }) => {
        this.worldMemory.upsertChest(info);
        this.emit("changed");
      }
    );
    this.bots.set(cfg.id, inst);
    return inst;
  }

  private persistBots() {
    void saveJson(BOTS_FILE, [...this.bots.values()].map((b) => b.config));
  }

  private botByUsername(username: string): BotInstance {
    const q = username.trim().toLowerCase();
    const inst = [...this.bots.values()].find((bot) => bot.config.username.toLowerCase() === q);
    if (!inst) throw new PanelError(`Bot not found: ${username}`, 404);
    return inst;
  }

  private applyPremiumUsername(accountId: string, username: string) {
    if (!USERNAME_RE.test(username)) return;
    for (const inst of this.bots.values()) {
      if (inst.config.accountId !== accountId) continue;
      if (inst.config.username.toLowerCase() === username.toLowerCase()) continue;
      try {
        this.assertValidNewBot(username, inst.config.serverId, inst.config.id);
        inst.config.username = username;
        this.log.success(`Bot renamed to premium username ${username}`);
      } catch (err) {
        this.log.warn(
          `Could not rename bot to ${username}`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    this.persistBots();
    this.emit("changed");
  }

  private applyAuth(
    cfg: BotConfig,
    auth: BotAuthType | undefined,
    accountId: string | null | undefined,
    username: string,
    ignoreBotId?: string
  ) {
    const mode: BotAuthType = auth === "microsoft" ? "microsoft" : "offline";
    if (mode === "offline") {
      cfg.auth = "offline";
      cfg.accountId = null;
      return;
    }
    if (!accountId) throw new PanelError("Choose a Microsoft account for this bot.");
    const account = accounts.get(accountId);
    if (!account) throw new PanelError("Microsoft account not found.", 404);
    if (account.username && account.username.toLowerCase() !== username.toLowerCase()) {
      this.assertValidNewBot(account.username, cfg.serverId, ignoreBotId ?? cfg.id);
      cfg.username = account.username;
    }
    cfg.auth = "microsoft";
    cfg.accountId = accountId;
  }

  private assertAccountFree(inst: BotInstance) {
    if (inst.config.auth !== "microsoft") return;
    const accountId = inst.config.accountId;
    if (!accountId || !accounts.get(accountId)) {
      throw new PanelError("Assign a Microsoft account before starting this bot.");
    }
    const other = [...this.bots.values()].find(
      (bot) =>
        bot.config.id !== inst.config.id &&
        bot.config.accountId === accountId &&
        bot.status !== "stopped" &&
        bot.status !== "error" &&
        bot.status !== "kicked"
    );
    if (other) {
      throw new PanelError(
        `Microsoft account is already used by "${other.config.username}". Stop that bot first — a server would kick one of them.`,
        409
      );
    }
  }

  private assertValidNewBot(username: string, serverId: string, ignoreBotId?: string) {
    if (!USERNAME_RE.test(username)) {
      throw new PanelError("Invalid username: 3-16 characters, letters/digits/underscore only.");
    }
    if (!this.getServer(serverId)) throw new PanelError("Server profile not found.", 404);
    const clash = [...this.bots.values()].find(
      (b) =>
        b.config.id !== ignoreBotId &&
        b.config.serverId === serverId &&
        b.config.username.toLowerCase() === username.toLowerCase()
    );
    if (clash) {
      throw new PanelError(
        `"${username}" is already defined on this server — offline mode uses name as identity.`,
        409
      );
    }
  }
}

function clampPort(p: unknown): number {
  const n = Math.floor(Number(p));
  if (!Number.isFinite(n) || n < 1 || n > 65535) throw new PanelError("Invalid port (1-65535).");
  return n;
}

function normalizeVersion(v: unknown): string {
  const s = String(v ?? "auto").trim();
  return s === "" ? "auto" : s;
}

function isDefined<T>(x: T | undefined): x is T {
  return x !== undefined;
}

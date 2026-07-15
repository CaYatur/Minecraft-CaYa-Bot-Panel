import { EventEmitter } from "events";
import { RuleEngine } from "../modules/automation/RuleEngine";
import { WorldMemory } from "../modules/world/memory";
import { loadJson, saveJson } from "../persistence/store";
import type { BotConfig, ServerProfile, StateSnapshot, Waypoint } from "../types";
import { USERNAME_RE, defaultBotConfig, mergeConfig, newId } from "../types";
import { createLogger } from "../utils/logger";
import { BotInstance } from "./BotInstance";
import { PanelError } from "./errors";
import { WaypointStore } from "./Waypoints";

// geriye dönük uyumluluk: PanelError eskiden bu dosyadaydı, mevcut import'lar bozulmasın
export { PanelError };

const BOTS_FILE = "bots.json";
const SERVERS_FILE = "servers.json";
const BULK_START_STAGGER_MS = 2_000; // sunucuyu bağlantı seliyle boğmamak için (Faz 2)

export interface CreateBotInput {
  username: string;
  serverId: string;
  autostart?: boolean;
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
    this.servers = loadJson<ServerProfile[]>(SERVERS_FILE, []);
    const configs = loadJson<BotConfig[]>(BOTS_FILE, []);
    for (const cfg of configs) this.instantiate(cfg);
    this.log.info(`${this.servers.length} sunucu profili, ${configs.length} bot tanımı yüklendi`);

    const autostart = [...this.bots.values()].filter((b) => b.config.autostart);
    if (autostart.length > 0) {
      this.log.info(`${autostart.length} bot autostart ile işaretli — kademeli başlatılıyor (İ4)`);
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
    if (!profile.host) throw new PanelError("Sunucu adresi (host) boş olamaz.");
    this.servers.push(profile);
    void saveJson(SERVERS_FILE, this.servers);
    this.log.success(`Sunucu profili eklendi: ${profile.name} (${profile.host}:${profile.port})`);
    this.emit("changed");
    return profile;
  }

  updateServer(id: string, patch: Partial<Omit<ServerProfile, "id">>): ServerProfile {
    const profile = this.servers.find((s) => s.id === id);
    if (!profile) throw new PanelError("Sunucu profili bulunamadı.", 404);
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
      throw new PanelError(`Bu profili ${inUse.length} bot kullanıyor — önce o botları sil veya taşı.`, 409);
    }
    const before = this.servers.length;
    this.servers = this.servers.filter((s) => s.id !== id);
    if (this.servers.length === before) throw new PanelError("Sunucu profili bulunamadı.", 404);
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
    const instance = this.instantiate(cfg);
    this.persistBots();
    this.log.success(`Bot oluşturuldu: ${username}`);
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
        continue; // isim çakıştı → sıradaki numara
      }
      const cfg = defaultBotConfig(name, serverId);
      cfg.autostart = autostart;
      const inst = this.instantiate(cfg);
      created.push(inst);
      this.emit("botAdded", inst);
      made++;
    }
    this.persistBots();
    this.log.success(`${created.length} bot oluşturuldu (şablon: ${tpl})`);
    return created;
  }

  updateBotConfig(id: string, patch: Partial<BotConfig>): BotInstance {
    const inst = this.mustGet(id);
    // id/serverId/username değişimi ayrı ele alınır; patch'ten ayıkla
    const { id: _ignore, username, serverId, ...rest } = patch;
    if (username !== undefined && username !== inst.config.username) {
      const name = String(username).trim();
      this.assertValidNewBot(name, serverId ?? inst.config.serverId, id);
      inst.config.username = name;
      if (inst.status !== "stopped") this.log.warn("Kullanıcı adı değişti — etkisi için botu yeniden başlat", name);
    }
    if (serverId !== undefined && serverId !== inst.config.serverId) {
      if (!this.getServer(serverId)) throw new PanelError("Hedef sunucu profili bulunamadı.", 404);
      inst.config.serverId = serverId;
      if (inst.status !== "stopped") this.log.warn("Sunucu değişti — etkisi için botu yeniden başlat");
    }
    inst.config = mergeConfig(inst.config, rest as Partial<BotConfig>);
    this.persistBots();
    this.emit("changed");
    return inst;
  }

  removeBot(id: string) {
    const inst = this.mustGet(id);
    inst.dispose();
    this.bots.delete(id);
    this.persistBots();
    this.log.info(`Bot silindi: ${inst.config.username}`);
    this.emit("botRemoved", id);
  }

  startBot(id: string) {
    this.mustGet(id).start();
  }

  stopBot(id: string) {
    this.mustGet(id).stop();
  }

  /** staggered start to avoid connection-flood kicks (Faz 2) */
  startStaggered(ids?: string[]) {
    const targets = (ids ?? [...this.bots.keys()]).map((id) => this.bots.get(id)).filter(isDefined);
    targets.forEach((inst, i) => {
      setTimeout(() => {
        // bot bu arada silinmiş olabilir
        if (this.bots.has(inst.config.id) && inst.status === "stopped") inst.start();
        else if (this.bots.has(inst.config.id)) inst.start();
      }, i * BULK_START_STAGGER_MS);
    });
    return targets.length;
  }

  stopAll(ids?: string[]) {
    const targets = (ids ?? [...this.bots.keys()]).map((id) => this.bots.get(id)).filter(isDefined);
    for (const t of targets) t.stop();
    return targets.length;
  }

  get(id: string): BotInstance | undefined {
    return this.bots.get(id);
  }

  mustGet(id: string): BotInstance {
    const inst = this.bots.get(id);
    if (!inst) throw new PanelError("Bot bulunamadı.", 404);
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
      }
    };
  }

  // ---- waypoints (değişiklikler "changed" ile panellere yayınlanır) -------------

  createWaypoint(serverId: string, input: { name: string; x: number; y: number; z: number; dimension?: string; note?: string }): Waypoint {
    if (!this.getServer(serverId)) throw new PanelError("Sunucu profili bulunamadı.", 404);
    const wp = this.waypoints.create(serverId, input);
    this.log.success(`Waypoint kaydedildi: ${wp.name} (${wp.x}, ${wp.y}, ${wp.z})`);
    this.emit("changed");
    return wp;
  }

  deleteWaypoint(id: string) {
    this.waypoints.delete(id);
    this.emit("changed");
  }

  shutdown() {
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
    const inst = new BotInstance(merged, (sid) => this.getServer(sid));
    // Faz 6: ölüm konumu → sunucu bazlı "ölüm-<bot>" waypoint (loot için)
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
          const name = `ölüm-${info.username}`;
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
            note: `Otomatik ölüm noktası ${new Date(info.ts).toISOString()}`
          });
        } catch (err) {
          this.log.warn("Ölüm waypoint yazılamadı", err instanceof Error ? err.message : String(err));
        }
        if (info.botId) this.rules.onBotEvent(info.botId, "died");
      }
    );
    inst.on("chatParsed", (entry: { botId: string; username?: string; text: string; kind: string }) => {
      if (entry.kind === "player" || entry.kind === "whisper") {
        this.rules.onChat(entry.botId, entry.username, entry.text);
      }
    });
    inst.on("spawned", (p: { botId: string }) => this.rules.onBotEvent(p.botId, "spawned"));
    inst.on("vitals", (p: { botId: string; health: number; food: number }) => this.rules.onVitals(p.botId, p.health, p.food));
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

  private assertValidNewBot(username: string, serverId: string, ignoreBotId?: string) {
    if (!USERNAME_RE.test(username)) {
      throw new PanelError("Geçersiz kullanıcı adı: 3-16 karakter, sadece harf/rakam/alt çizgi.");
    }
    if (!this.getServer(serverId)) throw new PanelError("Sunucu profili bulunamadı.", 404);
    const clash = [...this.bots.values()].find(
      (b) =>
        b.config.id !== ignoreBotId &&
        b.config.serverId === serverId &&
        b.config.username.toLowerCase() === username.toLowerCase()
    );
    if (clash) {
      throw new PanelError(
        `"${username}" bu sunucuda zaten tanımlı — offline modda isim kimliktir, aynı isim aynı sunucuya iki kez giremez.`,
        409
      );
    }
  }
}

function clampPort(p: unknown): number {
  const n = Math.floor(Number(p));
  if (!Number.isFinite(n) || n < 1 || n > 65535) throw new PanelError("Geçersiz port (1-65535).");
  return n;
}

function normalizeVersion(v: unknown): string {
  const s = String(v ?? "auto").trim();
  return s === "" ? "auto" : s;
}

function isDefined<T>(x: T | undefined): x is T {
  return x !== undefined;
}

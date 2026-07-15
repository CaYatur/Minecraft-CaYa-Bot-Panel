import { loadJson, saveJson } from "../../persistence/store";
import type { BotManager } from "../../core/BotManager";
import { createLogger } from "../../utils/logger";
import { newId } from "../../types";

const FILE = "rules.json";
const log = createLogger("rules");

export type TriggerType =
  | "chat"
  | "health_below"
  | "food_below"
  | "interval"
  | "bot_spawned"
  | "bot_died"
  | "item_count"
  | "attacked"
  | "player_nearby"
  | "player_joined"
  | "player_left"
  | "inventory_full"
  | "task_done"
  | "task_failed";

export interface RuleTrigger {
  type: TriggerType;
  pattern?: string;
  match?: "exact" | "contains" | "regex";
  /** authorized | anyone | isim listesi */
  from?: "authorized" | "anyone" | string[];
  /** belirli oyuncu (chat/attacked/nearby) */
  player?: string;
  threshold?: number;
  item?: string;
  ore?: string;
  comparison?: "lt" | "lte" | "gt" | "gte" | "eq";
  everyMs?: number;
  radius?: number;
  /** attacked: mob | player | all */
  source?: "mob" | "player" | "all";
  taskType?: string;
}

export interface RuleCondition {
  type:
    | "has_item"
    | "task_idle"
    | "health_below"
    | "food_below"
    | "in_dimension"
    | "online"
    | "player_near"
    | "item_count";
  item?: string;
  threshold?: number;
  dimension?: string;
  player?: string;
  radius?: number;
  comparison?: "lt" | "lte" | "gt" | "gte" | "eq";
}

export interface RuleAction {
  type: string;
  [k: string]: unknown;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  botIds: string[] | "all";
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  cooldownMs: number;
  maxTriggersPerMinute: number;
}

export class RuleEngine {
  rules: AutomationRule[] = [];
  private lastFire = new Map<string, number>();
  private minuteHits = new Map<string, number[]>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private dryRun = false;
  private knownPlayers = new Map<string, Set<string>>(); // botId -> names

  constructor(private readonly manager: BotManager) {}

  load() {
    this.rules = loadJson<AutomationRule[]>(FILE, []);
    this.rewireIntervals();
    log.info(`${this.rules.length} otomasyon kuralı yüklendi`);
  }

  private persist() {
    void saveJson(FILE, this.rules);
  }

  list() {
    return this.rules;
  }

  create(partial: Partial<AutomationRule>): AutomationRule {
    const rule: AutomationRule = {
      id: newId(),
      name: partial.name || "Yeni kural",
      enabled: partial.enabled ?? true,
      botIds: partial.botIds ?? "all",
      trigger: partial.trigger ?? { type: "chat", pattern: "gel", match: "contains", from: "authorized" },
      conditions: partial.conditions ?? [],
      actions: partial.actions ?? [{ type: "panel_notify", message: "kural tetiklendi", level: "info" }],
      cooldownMs: partial.cooldownMs ?? 3000,
      maxTriggersPerMinute: partial.maxTriggersPerMinute ?? 10
    };
    this.rules.push(rule);
    this.persist();
    this.rewireIntervals();
    this.manager.emit("changed");
    return rule;
  }

  update(id: string, patch: Partial<AutomationRule>): AutomationRule {
    const r = this.rules.find((x) => x.id === id);
    if (!r) throw new Error("Kural bulunamadı");
    Object.assign(r, patch, { id: r.id });
    this.persist();
    this.rewireIntervals();
    this.manager.emit("changed");
    return r;
  }

  remove(id: string) {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.persist();
    this.rewireIntervals();
    this.manager.emit("changed");
  }

  setDryRun(v: boolean) {
    this.dryRun = v;
  }

  async testRule(id: string, botId: string) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error("Kural bulunamadı");
    const prev = this.dryRun;
    this.dryRun = true;
    try {
      await this.execute(rule, botId, { player: "Test", text: "test", arg: "", attacker: "Test", ore: "iron", item: "stick" });
    } finally {
      this.dryRun = prev;
    }
  }

  onChat(botId: string, username: string | undefined, text: string) {
    this.fireMatching(botId, "chat", { player: username ?? "", text }, (rule) => this.matchChat(rule, botId, username, text));
  }

  onVitals(botId: string, health: number, food: number) {
    this.fireMatching(botId, "health_below", {}, (rule) => rule.trigger.type === "health_below" && health <= (rule.trigger.threshold ?? 6));
    this.fireMatching(botId, "food_below", {}, (rule) => rule.trigger.type === "food_below" && food <= (rule.trigger.threshold ?? 6));
  }

  onBotEvent(botId: string, kind: "spawned" | "died") {
    const t = kind === "spawned" ? "bot_spawned" : "bot_died";
    this.fireMatching(botId, t, {}, (rule) => rule.trigger.type === t);
  }

  onAttacked(botId: string, attacker: string | undefined, source: "mob" | "player") {
    this.fireMatching(botId, "attacked", { attacker: attacker ?? "", player: attacker ?? "" }, (rule) => {
      if (rule.trigger.type !== "attacked") return false;
      const want = rule.trigger.source ?? "all";
      if (want !== "all" && want !== source) return false;
      if (rule.trigger.player && attacker) {
        return attacker.toLowerCase() === rule.trigger.player.toLowerCase();
      }
      if (rule.trigger.player && !attacker) return false;
      return true;
    });
  }

  onNearby(botId: string, players: Array<{ username: string; distance: number }>) {
    for (const p of players) {
      this.fireMatching(botId, "player_nearby", { player: p.username, distance: String(Math.round(p.distance)) }, (rule) => {
        if (rule.trigger.type !== "player_nearby") return false;
        const r = rule.trigger.radius ?? 16;
        if (p.distance > r) return false;
        if (rule.trigger.player && p.username.toLowerCase() !== rule.trigger.player.toLowerCase()) return false;
        const from = rule.trigger.from;
        if (from === "authorized") {
          const inst = this.manager.get(botId);
          const ok = inst?.config.authorizedPlayers.map((x) => x.toLowerCase()).includes(p.username.toLowerCase());
          if (!ok) return false;
        } else if (Array.isArray(from)) {
          if (!from.map((x) => x.toLowerCase()).includes(p.username.toLowerCase())) return false;
        }
        return true;
      });
    }
  }

  onTabPlayers(botId: string, names: string[]) {
    const prev = this.knownPlayers.get(botId) ?? new Set();
    const next = new Set(names.map((n) => n.toLowerCase()));
    for (const n of next) {
      if (!prev.has(n)) {
        const display = names.find((x) => x.toLowerCase() === n) ?? n;
        this.fireMatching(botId, "player_joined", { player: display }, (rule) => rule.trigger.type === "player_joined");
      }
    }
    for (const n of prev) {
      if (!next.has(n)) {
        this.fireMatching(botId, "player_left", { player: n }, (rule) => rule.trigger.type === "player_left");
      }
    }
    this.knownPlayers.set(botId, next);
  }

  onInventoryFull(botId: string) {
    this.fireMatching(botId, "inventory_full", {}, (rule) => rule.trigger.type === "inventory_full");
  }

  onTaskEvent(botId: string, kind: "done" | "failed", taskType: string, label: string) {
    const t = kind === "done" ? "task_done" : "task_failed";
    this.fireMatching(botId, t, { taskType, label }, (rule) => {
      if (rule.trigger.type !== t) return false;
      if (rule.trigger.taskType && rule.trigger.taskType !== taskType) return false;
      return true;
    });
  }

  onItemCountTick(botId: string) {
    const inst = this.manager.get(botId);
    if (!inst) return;
    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger.type !== "item_count") continue;
      if (!this.appliesToBot(rule, botId)) continue;
      try {
        const item = rule.trigger.item;
        if (!item) continue;
        const count = countItem(inst, item);
        if (!compare(count, rule.trigger.comparison ?? "lte", rule.trigger.threshold ?? 0)) continue;
        if (!this.conditionsOk(rule, botId)) continue;
        if (!this.rateOk(rule)) continue;
        void this.execute(rule, botId, { item, count: String(count) });
      } catch (e) {
        log.error(`item_count kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  private fireMatching(
    botId: string,
    _label: string,
    ctx: Record<string, string>,
    match: (rule: AutomationRule) => boolean
  ) {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!this.appliesToBot(rule, botId)) continue;
      try {
        if (!match(rule)) continue;
        if (!this.conditionsOk(rule, botId)) continue;
        if (!this.rateOk(rule)) continue;
        void this.execute(rule, botId, ctx);
      } catch (e) {
        log.error(`Kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
        rule.enabled = false;
        this.persist();
      }
    }
  }

  private rewireIntervals() {
    for (const t of this.intervals.values()) clearInterval(t);
    this.intervals.clear();
    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger.type !== "interval") continue;
      const ms = Math.max(5000, rule.trigger.everyMs ?? 60_000);
      const timer = setInterval(() => {
        const bots = rule.botIds === "all" ? [...this.manager.bots.keys()] : rule.botIds;
        for (const botId of bots) {
          try {
            if (this.conditionsOk(rule, botId) && this.rateOk(rule)) void this.execute(rule, botId, {});
          } catch (e) {
            log.error(`Interval kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
          }
        }
      }, ms);
      this.intervals.set(rule.id, timer);
    }

    // item_count polling for all bots every 20s
    const itemTimer = setInterval(() => {
      for (const id of this.manager.bots.keys()) this.onItemCountTick(id);
    }, 20_000);
    this.intervals.set("__item_count_poll__", itemTimer);
  }

  private appliesToBot(rule: AutomationRule, botId: string) {
    return rule.botIds === "all" || rule.botIds.includes(botId);
  }

  private matchChat(rule: AutomationRule, botId: string, username: string | undefined, text: string): boolean {
    if (rule.trigger.type !== "chat") return false;
    const tr = rule.trigger;
    if (tr.player && username && username.toLowerCase() !== tr.player.toLowerCase()) return false;
    if (tr.player && !username) return false;

    const from = tr.from ?? "authorized";
    if (from === "authorized") {
      const inst = this.manager.get(botId);
      const allowed =
        Boolean(username) &&
        Boolean(inst?.config.authorizedPlayers.map((x) => x.toLowerCase()).includes(username!.toLowerCase()));
      if (!allowed) return false;
    } else if (Array.isArray(from)) {
      if (!username || !from.map((x) => x.toLowerCase()).includes(username.toLowerCase())) return false;
    }
    const pat = tr.pattern ?? "";
    const mode = tr.match ?? "contains";
    if (!pat && mode !== "exact") return true; // boş desen = her mesaj (dikkatli)
    if (mode === "exact") return text.trim() === pat;
    if (mode === "regex") {
      try {
        return new RegExp(pat, "i").test(text);
      } catch {
        throw new Error(`Geçersiz regex: ${pat}`);
      }
    }
    return text.toLowerCase().includes(pat.toLowerCase());
  }

  private rateOk(rule: AutomationRule): boolean {
    const now = Date.now();
    const last = this.lastFire.get(rule.id) ?? 0;
    if (now - last < (rule.cooldownMs ?? 0)) return false;
    const hits = (this.minuteHits.get(rule.id) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= (rule.maxTriggersPerMinute ?? 10)) return false;
    hits.push(now);
    this.minuteHits.set(rule.id, hits);
    this.lastFire.set(rule.id, now);
    return true;
  }

  private conditionsOk(rule: AutomationRule, botId: string): boolean {
    const inst = this.manager.get(botId);
    if (!inst) return false;
    for (const c of rule.conditions) {
      if (c.type === "online" && inst.status !== "online") return false;
      if (c.type === "task_idle" && inst.tasks.currentSummary) return false;
      if (c.type === "health_below" && inst.runtime.health > (c.threshold ?? 10)) return false;
      if (c.type === "food_below" && inst.runtime.food > (c.threshold ?? 10)) return false;
      if (c.type === "in_dimension" && c.dimension && inst.runtime.dimension !== c.dimension) return false;
      if (c.type === "has_item" && c.item) {
        if (countItem(inst, c.item) <= 0) return false;
      }
      if (c.type === "item_count" && c.item) {
        if (!compare(countItem(inst, c.item), c.comparison ?? "gte", c.threshold ?? 1)) return false;
      }
      if (c.type === "player_near" && c.player) {
        const bot = inst.bot;
        if (!bot) return false;
        const ent = bot.players[c.player]?.entity;
        if (!ent) return false;
        const d = bot.entity.position.distanceTo(ent.position);
        if (d > (c.radius ?? 16)) return false;
      }
    }
    return true;
  }

  private async execute(rule: AutomationRule, botId: string, ctx: Record<string, string>) {
    const inst = this.manager.get(botId);
    if (!inst) return;
    log.info(`Kural tetik: ${rule.name}`, `bot=${inst.config.username}`);
    for (const action of rule.actions) {
      try {
        await this.runAction(inst.config.id, action, ctx);
      } catch (e) {
        log.error(`Aksiyon hata (${action.type})`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  private async runAction(botId: string, action: RuleAction, ctx: Record<string, string>) {
    const inst = this.manager.get(botId);
    if (!inst) return;
    const type = String(action.type);

    if (this.dryRun) {
      log.info(`[TEST] ${type}`, JSON.stringify({ ...action, ctx }));
      return;
    }

    if (type === "panel_notify") {
      const level = String(action.level ?? "info");
      const msg = interpolate(String(action.message ?? ""), ctx);
      if (level === "error") log.error(msg);
      else if (level === "success") log.success(msg);
      else if (level === "warn") log.warn(msg);
      else log.info(msg);
      return;
    }
    if (type === "send_chat") {
      inst.sendChat(interpolate(String(action.text ?? ""), ctx));
      return;
    }
    if (type === "wait") {
      await new Promise((r) => setTimeout(r, Math.max(0, Number(action.seconds ?? 1) * 1000)));
      return;
    }
    if (type === "stop_tasks") {
      inst.tasks.cancelAll("otomasyon stop_tasks");
      return;
    }
    if (type === "eat") {
      inst.survival.enqueueEatNow();
      return;
    }
    if (type === "hunt") {
      inst.survival.enqueueHunt(Number(action.radius ?? 32));
      return;
    }
    if (type === "cook") {
      inst.survival.enqueueCook();
      return;
    }
    if (type === "acquire_food" || type === "acquire-food") {
      inst.survival.enqueueAcquireFood();
      return;
    }
    if (type === "flee") {
      inst.combat.enqueueFlee(ctx.attacker || ctx.player);
      return;
    }
    if (type === "defend_self") {
      inst.config.combat.defendMode = (action.mode as "all" | "mob" | "player") || "all";
      return;
    }
    if (type === "set_defend") {
      inst.config.combat.defendMode = (String(action.mode ?? "all") as "off" | "mob" | "player" | "all") || "all";
      return;
    }
    if (type === "attack") {
      const target = interpolate(String(action.target ?? action.player ?? ctx.player ?? ctx.attacker ?? ""), ctx);
      if (target) inst.combat.enqueueAttackPlayer(target);
      return;
    }
    if (type === "clear_mobs" || type === "clear-mobs") {
      inst.combat.enqueueClearMobs(Number(action.radius ?? 16));
      return;
    }
    if (type === "follow") {
      const p = interpolate(String(action.player ?? ctx.player ?? ""), ctx);
      if (p) inst.enqueueAction({ type: "follow", player: p, distance: Number(action.distance ?? 3) });
      return;
    }
    if (type === "goto") {
      if (action.waypoint) {
        // resolved in REST only — try manager waypoints by name
        const name = interpolate(String(action.waypoint), ctx);
        const list = this.manager.waypoints.forServer(inst.config.serverId);
        const wp = list.find((w) => w.name.toLowerCase() === name.toLowerCase() || w.id === name);
        if (wp) inst.enqueueAction({ type: "goto", x: wp.x, y: wp.y, z: wp.z, label: `waypoint: ${wp.name}` });
      } else if (action.player || ctx.player) {
        inst.enqueueAction({ type: "goto-player", player: interpolate(String(action.player ?? ctx.player), ctx) });
      } else if (action.x != null) {
        inst.enqueueAction({ type: "goto", x: action.x, y: action.y, z: action.z });
      }
      return;
    }
    if (type === "collect" || type === "collect_wood" || type === "odun-topla") {
      const logType = action.block ? String(action.block) : action.logType ? String(action.logType) : undefined;
      inst.gather.enqueueCollectWood(Number(action.count ?? 16), logType);
      return;
    }
    if (type === "collect_drops" || type === "eşya-topla") {
      inst.gather.enqueueCollectDrops(action.filter ? String(action.filter) : undefined, Number(action.radius ?? 16));
      return;
    }
    if (type === "mine" || type === "maden-topla") {
      const ore = interpolate(String(action.ore ?? ctx.ore ?? "iron"), ctx).replace(/_ore$/, "");
      inst.gather.enqueueMine(ore, Number(action.count ?? 8), action.mode === "utility" ? "utility" : "legit");
      return;
    }
    if (type === "craft" || type === "üret") {
      inst.craft.enqueueCraft(interpolate(String(action.item ?? ctx.item ?? "stick"), ctx), Number(action.count ?? 1));
      return;
    }
    if (type === "deposit" || type === "depoya-bırak") {
      inst.enqueueAction({ type: "deposit", filter: action.filter ?? "" });
      return;
    }
    if (type === "withdraw" || type === "depodan-al") {
      inst.enqueueAction({ type: "withdraw", item: action.item ?? ctx.item, count: action.count ?? 1 });
      return;
    }
    if (type === "stop") {
      inst.enqueueAction({ type: "stop" });
      return;
    }
    inst.enqueueAction({ ...action, type });
  }
}

function countItem(inst: { getSnapshot: () => { inventory: { slots: Array<{ name: string; count: number } | null> } | null } }, item: string): number {
  const inv = inst.getSnapshot().inventory;
  if (!inv) return 0;
  let n = 0;
  for (const s of inv.slots) {
    if (s && (s.name === item || s.name.includes(item))) n += s.count;
  }
  return n;
}

function compare(value: number, op: string, thr: number): boolean {
  switch (op) {
    case "lt":
      return value < thr;
    case "lte":
      return value <= thr;
    case "gt":
      return value > thr;
    case "gte":
      return value >= thr;
    case "eq":
      return value === thr;
    default:
      return value <= thr;
  }
}

function interpolate(s: string, ctx: Record<string, string>) {
  return s.replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? "");
}

export const RULE_TEMPLATES: Array<Partial<AutomationRule>> = [
  {
    name: "Gel komutu",
    trigger: { type: "chat", pattern: "gel", match: "contains", from: "authorized" },
    actions: [
      { type: "goto", player: "{player}" },
      { type: "panel_notify", message: "{player} için gel", level: "info" }
    ],
    cooldownMs: 2000
  },
  {
    name: "Takip et komutu",
    trigger: { type: "chat", pattern: "takip", match: "contains", from: "authorized" },
    actions: [{ type: "follow", player: "{player}", distance: 3 }],
    cooldownMs: 2000
  },
  {
    name: "Beni koru",
    trigger: { type: "chat", pattern: "koru", match: "contains", from: "authorized" },
    actions: [
      { type: "defend_self", mode: "all" },
      { type: "panel_notify", message: "Savunma: hepsi", level: "success" }
    ]
  },
  {
    name: "Saldırıya karşılık",
    trigger: { type: "attacked", source: "player" },
    actions: [
      { type: "attack", player: "{attacker}" },
      { type: "panel_notify", message: "{attacker} saldırdı — karşılık", level: "warn" }
    ],
    cooldownMs: 5000
  },
  {
    name: "Mob saldırısında kaç",
    trigger: { type: "attacked", source: "mob" },
    conditions: [{ type: "health_below", threshold: 10 }],
    actions: [{ type: "flee" }, { type: "panel_notify", message: "Mob saldırısı — kaçış", level: "warn" }],
    cooldownMs: 8000
  },
  {
    name: "Oduncu",
    trigger: { type: "interval", everyMs: 120_000 },
    conditions: [{ type: "task_idle" }, { type: "online" }],
    actions: [{ type: "collect", count: 32, block: "oak_log" }]
  },
  {
    name: "Demir madencisi",
    trigger: { type: "interval", everyMs: 180_000 },
    conditions: [{ type: "task_idle" }],
    actions: [{ type: "mine", ore: "iron", count: 16, mode: "legit" }]
  },
  {
    name: "Odun azsa topla",
    trigger: { type: "item_count", item: "oak_log", comparison: "lt", threshold: 16 },
    conditions: [{ type: "task_idle" }],
    actions: [{ type: "collect", count: 32, block: "oak_log" }],
    cooldownMs: 60_000
  },
  {
    name: "Yemek nöbetçisi",
    trigger: { type: "food_below", threshold: 10 },
    actions: [{ type: "eat" }, { type: "acquire_food" }],
    cooldownMs: 15_000
  },
  {
    name: "Can kritik — kaç",
    trigger: { type: "health_below", threshold: 6 },
    actions: [{ type: "flee" }, { type: "panel_notify", message: "Can kritik", level: "error" }],
    cooldownMs: 10_000
  },
  {
    name: "Yakındaki yetkiliye selam",
    trigger: { type: "player_nearby", radius: 8, from: "authorized" },
    actions: [{ type: "send_chat", text: "sa {player}" }],
    cooldownMs: 120_000,
    maxTriggersPerMinute: 2
  },
  {
    name: "Envanter dolu uyarısı",
    trigger: { type: "inventory_full" },
    actions: [
      { type: "panel_notify", message: "Envanter doldu", level: "warn" },
      { type: "deposit" }
    ],
    cooldownMs: 30_000
  },
  {
    name: "Hoş geldin",
    trigger: { type: "chat", pattern: "sa", match: "contains", from: "anyone" },
    actions: [{ type: "send_chat", text: "as {player}" }],
    cooldownMs: 10_000,
    maxTriggersPerMinute: 3
  },
  {
    name: "Belirli kişi: gel",
    trigger: { type: "chat", pattern: "gel", match: "contains", from: "anyone", player: "" },
    actions: [{ type: "goto", player: "{player}" }],
    cooldownMs: 2000
  },
  {
    name: "Giriş yapanı karşılama",
    trigger: { type: "player_joined" },
    actions: [{ type: "send_chat", text: "hoş geldin {player}" }],
    cooldownMs: 5000,
    maxTriggersPerMinute: 6
  },
  {
    name: "Stick üret (azsa)",
    trigger: { type: "item_count", item: "stick", comparison: "lt", threshold: 8 },
    conditions: [{ type: "task_idle" }],
    actions: [{ type: "craft", item: "stick", count: 16 }],
    cooldownMs: 45_000
  }
];

export const TRIGGER_META: Array<{ type: TriggerType; label: string; fields: string[] }> = [
  { type: "chat", label: "Sohbet mesajı", fields: ["pattern", "match", "from", "player"] },
  { type: "attacked", label: "Saldırıya uğradı", fields: ["source", "player"] },
  { type: "player_nearby", label: "Yakında oyuncu", fields: ["radius", "player"] },
  { type: "player_joined", label: "Oyuncu girdi (tab)", fields: [] },
  { type: "player_left", label: "Oyuncu çıktı (tab)", fields: [] },
  { type: "health_below", label: "Can eşiğin altında", fields: ["threshold"] },
  { type: "food_below", label: "Açlık eşiğin altında", fields: ["threshold"] },
  { type: "item_count", label: "Eşya adedi", fields: ["item", "comparison", "threshold"] },
  { type: "inventory_full", label: "Envanter doldu", fields: [] },
  { type: "interval", label: "Zamanlayıcı", fields: ["everyMs"] },
  { type: "bot_spawned", label: "Bot spawn oldu", fields: [] },
  { type: "bot_died", label: "Bot öldü", fields: [] },
  { type: "task_done", label: "Görev bitti", fields: ["taskType"] },
  { type: "task_failed", label: "Görev başarısız", fields: ["taskType"] }
];

export const ACTION_META: Array<{ type: string; label: string; fields: string[] }> = [
  { type: "send_chat", label: "Sohbete yaz", fields: ["text"] },
  { type: "goto", label: "Git (oyuncu/waypoint/xyz)", fields: ["player", "waypoint", "x", "y", "z"] },
  { type: "follow", label: "Takip et", fields: ["player", "distance"] },
  { type: "attack", label: "Saldır", fields: ["player"] },
  { type: "clear-mobs", label: "Mob temizle", fields: ["radius"] },
  { type: "flee", label: "Kaç", fields: [] },
  { type: "defend_self", label: "Savunma aç", fields: ["mode"] },
  { type: "eat", label: "Ye", fields: [] },
  { type: "hunt", label: "Avlan", fields: ["radius"] },
  { type: "cook", label: "Pişir", fields: [] },
  { type: "acquire_food", label: "Yemek edin", fields: [] },
  { type: "collect", label: "Odun/blok topla", fields: ["block", "count"] },
  { type: "mine", label: "Maden topla", fields: ["ore", "count", "mode"] },
  { type: "craft", label: "Üret", fields: ["item", "count"] },
  { type: "collect_drops", label: "Yerdeki eşya", fields: ["filter", "radius"] },
  { type: "deposit", label: "Depoya bırak", fields: ["filter"] },
  { type: "withdraw", label: "Depodan al", fields: ["item", "count"] },
  { type: "stop_tasks", label: "Görevleri durdur", fields: [] },
  { type: "stop", label: "Hareket/dövüş stop", fields: [] },
  { type: "wait", label: "Bekle (sn)", fields: ["seconds"] },
  { type: "panel_notify", label: "Panel bildirimi", fields: ["message", "level"] }
];

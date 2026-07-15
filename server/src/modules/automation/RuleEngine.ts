import { loadJson, saveJson } from "../../persistence/store";
import type { BotManager } from "../../core/BotManager";
import { createLogger } from "../../utils/logger";
import { newId } from "../../types";
import { findBlueprint, RULE_BLUEPRINTS, type RuleBlueprint } from "./blueprints";

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
  /** envantere yeni eşya geldi / adet arttı */
  | "item_gained"
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
  /**
   * exact | contains | regex | startsWith | command
   * command: "/gel Steve" → pattern "gel", arg0=Steve (prefix varsayılan /)
   */
  match?: "exact" | "contains" | "regex" | "startsWith" | "command";
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
  /** slash komut öneki (varsayılan "/") — "!gel" için "!" */
  commandPrefix?: string;
}

export interface RuleCondition {
  type:
    | "has_item"
    | "not_has_item"
    | "task_idle"
    | "task_busy"
    | "health_below"
    | "health_above"
    | "food_below"
    | "food_above"
    | "in_dimension"
    | "online"
    | "offline"
    | "player_near"
    | "item_count"
    | "time_day"
    | "time_night";
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
  /** item_gained: botId -> itemName -> last count */
  private itemSnapshots = new Map<string, Map<string, number>>();

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
    // komut argümanları (arg0, arg…) için özel yol
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!this.appliesToBot(rule, botId)) continue;
      if (rule.trigger.type !== "chat") continue;
      try {
        const hit = this.matchChatDetailed(rule, botId, username, text);
        if (!hit) continue;
        if (!this.conditionsOk(rule, botId)) continue;
        if (!this.rateOk(rule)) continue;
        void this.execute(rule, botId, {
          player: username ?? "",
          text,
          ...hit
        });
      } catch (e) {
        log.error(`Kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
        rule.enabled = false;
        this.persist();
      }
    }
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
      const want = (rule.trigger.taskType ?? "").trim();
      if (!want) return true;
      // "collect-wood|collect-block|mine" veya tek tip; includes eşleşmesi
      const aliases = want.split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const got = taskType.toLowerCase();
      return aliases.some((a) => got === a || got.includes(a) || a.includes(got));
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
    // envantere yeni eşya / adet artışı
    this.onItemGainedTick(botId);
  }

  /**
   * Envanterde belirli eşyanın adedi arttıysa (toplama/loot/craft sonucu).
   * trigger.item opsiyonel: boşsa herhangi bir artış; doluysa o eşya (includes match).
   * trigger.threshold: minimum artım (varsayılan 1).
   */
  onItemGainedTick(botId: string) {
    const inst = this.manager.get(botId);
    if (!inst || inst.status !== "online") return;
    const snap = inst.getSnapshot().inventory;
    if (!snap) return;

    const nowMap = new Map<string, number>();
    for (const s of snap.slots) {
      if (!s) continue;
      nowMap.set(s.name, (nowMap.get(s.name) ?? 0) + s.count);
    }

    const prev = this.itemSnapshots.get(botId) ?? new Map<string, number>();
    const gains: Array<{ item: string; delta: number; count: number }> = [];
    for (const [name, count] of nowMap) {
      const before = prev.get(name) ?? 0;
      if (count > before) gains.push({ item: name, delta: count - before, count });
    }
    this.itemSnapshots.set(botId, nowMap);
    // ilk snapshot — tetikleme (yanlış “hepsini aldı” spam’i olmasın)
    if (prev.size === 0) return;
    if (!gains.length) return;

    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger.type !== "item_gained") continue;
      if (!this.appliesToBot(rule, botId)) continue;
      try {
        const want = (rule.trigger.item ?? "").replace(/^minecraft:/, "").toLowerCase();
        const minDelta = Math.max(1, rule.trigger.threshold ?? 1);
        const hit = gains.find((g) => {
          if (g.delta < minDelta) return false;
          if (!want) return true;
          const n = g.item.toLowerCase();
          return n === want || n.includes(want) || want.includes(n);
        });
        if (!hit) continue;
        if (!this.conditionsOk(rule, botId)) continue;
        if (!this.rateOk(rule)) continue;
        void this.execute(rule, botId, {
          item: hit.item,
          count: String(hit.count),
          delta: String(hit.delta),
          gained: hit.item
        });
      } catch (e) {
        log.error(`item_gained kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
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

  /**
   * Sohbet eşleşmesi. true yerine ctx map döner (komut argümanları).
   * null = eşleşmedi.
   */
  private matchChatDetailed(
    rule: AutomationRule,
    botId: string,
    username: string | undefined,
    text: string
  ): Record<string, string> | null {
    if (rule.trigger.type !== "chat") return null;
    const tr = rule.trigger;
    if (tr.player && username && username.toLowerCase() !== tr.player.toLowerCase()) return null;
    if (tr.player && !username) return null;

    const from = tr.from ?? "authorized";
    if (from === "authorized") {
      const inst = this.manager.get(botId);
      const allowed =
        Boolean(username) &&
        Boolean(inst?.config.authorizedPlayers.map((x) => x.toLowerCase()).includes(username!.toLowerCase()));
      if (!allowed) return null;
    } else if (Array.isArray(from)) {
      if (!username || !from.map((x) => x.toLowerCase()).includes(username.toLowerCase())) return null;
    }

    const pat = tr.pattern ?? "";
    const mode = tr.match ?? "contains";
    const raw = text.trim();
    const lower = raw.toLowerCase();

    if (mode === "command") {
      const prefix = tr.commandPrefix ?? "/";
      if (!raw.startsWith(prefix)) return null;
      const body = raw.slice(prefix.length).trim();
      if (!body) return null;
      const parts = body.split(/\s+/);
      const cmd = (parts[0] ?? "").toLowerCase();
      // pattern: "gel" veya "gel|come|here"
      const aliases = pat
        .split("|")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (aliases.length && !aliases.includes(cmd)) return null;
      const args = parts.slice(1);
      const ctx: Record<string, string> = {
        command: cmd,
        arg: args.join(" "),
        args: args.join(" "),
        arg0: args[0] ?? "",
        arg1: args[1] ?? "",
        arg2: args[2] ?? ""
      };
      return ctx;
    }

    if (!pat && mode !== "exact") return {}; // boş desen = her mesaj
    if (mode === "exact") return raw === pat ? {} : null;
    if (mode === "startsWith") return lower.startsWith(pat.toLowerCase()) ? {} : null;
    if (mode === "regex") {
      try {
        return new RegExp(pat, "i").test(raw) ? {} : null;
      } catch {
        throw new Error(`Geçersiz regex: ${pat}`);
      }
    }
    // contains
    return lower.includes(pat.toLowerCase()) ? {} : null;
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
    for (const c of rule.conditions ?? []) {
      if (c.type === "online" && inst.status !== "online") return false;
      if (c.type === "offline" && inst.status === "online") return false;
      if (c.type === "task_idle" && inst.tasks.currentSummary) return false;
      if (c.type === "task_busy" && !inst.tasks.currentSummary) return false;
      if (c.type === "health_below" && inst.runtime.health > (c.threshold ?? 10)) return false;
      if (c.type === "health_above" && inst.runtime.health < (c.threshold ?? 10)) return false;
      if (c.type === "food_below" && inst.runtime.food > (c.threshold ?? 10)) return false;
      if (c.type === "food_above" && inst.runtime.food < (c.threshold ?? 10)) return false;
      if (c.type === "in_dimension" && c.dimension && inst.runtime.dimension !== c.dimension) return false;
      if (c.type === "has_item" && c.item) {
        if (countItem(inst, c.item) <= 0) return false;
      }
      if (c.type === "not_has_item" && c.item) {
        if (countItem(inst, c.item) > 0) return false;
      }
      if (c.type === "item_count" && c.item) {
        if (!compare(countItem(inst, c.item), c.comparison ?? "gte", c.threshold ?? 1)) return false;
      }
      if (c.type === "player_near" && c.player) {
        const bot = inst.bot;
        if (!bot?.entity) return false;
        const ent = bot.players[c.player]?.entity;
        if (!ent) return false;
        const d = bot.entity.position.distanceTo(ent.position);
        if (d > (c.radius ?? 16)) return false;
      }
      if (c.type === "time_day" || c.type === "time_night") {
        const bot = inst.bot;
        if (!bot) return false;
        const t = ((bot.time?.timeOfDay ?? 0) % 24000 + 24000) % 24000;
        const isDay = t >= 0 && t < 12000;
        if (c.type === "time_day" && !isDay) return false;
        if (c.type === "time_night" && isDay) return false;
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
    if (type === "collect" || type === "collect_wood" || type === "odun-topla" || type === "collect_item") {
      // {arg0}/{item} interpolate; adet string gelebilir
      const name = interpolate(String(action.block ?? action.item ?? action.logType ?? "oak_log"), ctx).replace(
        /^minecraft:/,
        ""
      );
      const rawCount = action.count != null ? interpolate(String(action.count), ctx) : "16";
      const n = Math.max(1, Number(rawCount) || 16);
      if (!name || name.startsWith("{")) {
        log.warn("collect: eşya adı yok", JSON.stringify(action));
        return;
      }
      if (name.endsWith("_log") || name.endsWith("_stem") || name === "log") {
        inst.gather.enqueueCollectWood(n, name === "log" ? undefined : name);
      } else {
        inst.gather.enqueueCollectBlock(name, n);
      }
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
    if (type === "reset-work" || type === "reset_work" || type === "soft-reset") {
      inst.resetAllWork("otomasyon reset-work");
      return;
    }
    if (type === "protect" || type === "social-protect") {
      const p = interpolate(String(action.player ?? ctx.player ?? ""), ctx);
      if (p) {
        inst.enqueueAction({
          type: "social-protect",
          player: p,
          enabled: action.enabled !== false,
          setAsMain: action.setAsMain !== false
        });
      }
      return;
    }
    if (type === "social-follow") {
      const p = interpolate(String(action.player ?? ctx.player ?? ""), ctx);
      if (p) {
        inst.enqueueAction({
          type: "social-follow",
          player: p,
          enabled: action.enabled !== false,
          distance: Number(action.distance ?? 3)
        });
      }
      return;
    }
    if (type === "social-attack") {
      const p = interpolate(String(action.player ?? action.target ?? ctx.player ?? ctx.attacker ?? ""), ctx);
      if (p) {
        inst.enqueueAction({ type: "social-attack", player: p, enabled: action.enabled !== false });
      }
      return;
    }
    if (type === "equip_best" || type === "equip-best") {
      void inst.combat.equipBestWeapon(true);
      return;
    }
    if (type === "loot_death" || type === "loot-death") {
      inst.combat.enqueueLootDeath();
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

/** Geriye uyum: isim = blueprint adı */
export const RULE_TEMPLATES: Array<Partial<AutomationRule> & { name: string }> = RULE_BLUEPRINTS.map((b) => ({
  ...b.rule,
  name: b.name
}));

export { RULE_BLUEPRINTS, findBlueprint };
export type { RuleBlueprint };

export const TRIGGER_META: Array<{ type: TriggerType; label: string; fields: string[]; hint?: string }> = [
  {
    type: "chat",
    label: "Sohbet / komut",
    fields: ["pattern", "match", "from", "player", "commandPrefix"],
    hint: "match=command → /gel Steve (arg0). startsWith, contains, exact, regex."
  },
  { type: "attacked", label: "Bot saldırıya uğradı", fields: ["source", "player"], hint: "mob | player | all" },
  { type: "player_nearby", label: "Yakında oyuncu", fields: ["radius", "player", "from"] },
  { type: "player_joined", label: "Oyuncu girdi (tab)", fields: [] },
  { type: "player_left", label: "Oyuncu çıktı (tab)", fields: [] },
  { type: "health_below", label: "Can eşiğin altında", fields: ["threshold"] },
  { type: "food_below", label: "Açlık eşiğin altında", fields: ["threshold"] },
  {
    type: "item_count",
    label: "Eşya adedi (eşik)",
    fields: ["item", "comparison", "threshold"],
    hint: "Örn. oak_log < 16 → topla"
  },
  {
    type: "item_gained",
    label: "Eşya envantere geldi / arttı",
    fields: ["item", "threshold"],
    hint: "Toplama/loot/craft sonrası adet artınca. item boş = herhangi; threshold = min artım"
  },
  { type: "inventory_full", label: "Envanter doldu", fields: [] },
  { type: "interval", label: "Zamanlayıcı", fields: ["everyMs"] },
  { type: "bot_spawned", label: "Bot spawn oldu", fields: [] },
  { type: "bot_died", label: "Bot öldü", fields: [] },
  {
    type: "task_done",
    label: "Görev başarıyla bitti",
    fields: ["taskType"],
    hint: "collect-wood, mine, craft, gather… taskType boş = hepsi"
  },
  { type: "task_failed", label: "Görev başarısız", fields: ["taskType"] }
];

export const CONDITION_META: Array<{ type: RuleCondition["type"]; label: string; fields: string[] }> = [
  { type: "online", label: "Bot online", fields: [] },
  { type: "offline", label: "Bot offline", fields: [] },
  { type: "task_idle", label: "Görev yok (boşta)", fields: [] },
  { type: "task_busy", label: "Görev çalışıyor", fields: [] },
  { type: "health_below", label: "Can ≤ eşik", fields: ["threshold"] },
  { type: "health_above", label: "Can ≥ eşik", fields: ["threshold"] },
  { type: "food_below", label: "Açlık ≤ eşik", fields: ["threshold"] },
  { type: "food_above", label: "Açlık ≥ eşik", fields: ["threshold"] },
  { type: "has_item", label: "Eşya var", fields: ["item"] },
  { type: "not_has_item", label: "Eşya yok", fields: ["item"] },
  { type: "item_count", label: "Eşya adedi", fields: ["item", "comparison", "threshold"] },
  { type: "player_near", label: "Oyuncu yakında", fields: ["player", "radius"] },
  { type: "in_dimension", label: "Boyut", fields: ["dimension"] },
  { type: "time_day", label: "Gündüz", fields: [] },
  { type: "time_night", label: "Gece", fields: [] }
];

export const ACTION_META: Array<{ type: string; label: string; fields: string[]; category?: string }> = [
  { type: "send_chat", label: "Sohbete yaz", fields: ["text"], category: "Sohbet" },
  { type: "panel_notify", label: "Panel bildirimi", fields: ["message", "level"], category: "Sohbet" },
  { type: "goto", label: "Git (oyuncu/waypoint/xyz)", fields: ["player", "waypoint", "x", "y", "z"], category: "Hareket" },
  { type: "follow", label: "Takip et", fields: ["player", "distance"], category: "Hareket" },
  { type: "social-follow", label: "Takip (toggle companion)", fields: ["player", "distance"], category: "Hareket" },
  { type: "stop", label: "Hareket/dövüş stop", fields: [], category: "Hareket" },
  { type: "reset-work", label: "Tüm işleri sıfırla", fields: [], category: "Hareket" },
  { type: "stop_tasks", label: "Görev kuyruğunu temizle", fields: [], category: "Hareket" },
  { type: "wait", label: "Bekle (sn)", fields: ["seconds"], category: "Hareket" },
  { type: "attack", label: "Saldır", fields: ["player"], category: "Dövüş" },
  { type: "social-attack", label: "Saldır (toggle)", fields: ["player"], category: "Dövüş" },
  { type: "clear-mobs", label: "Mob temizle", fields: ["radius"], category: "Dövüş" },
  { type: "flee", label: "Kaç", fields: [], category: "Dövüş" },
  { type: "protect", label: "Koru (eşlik)", fields: ["player"], category: "Dövüş" },
  { type: "defend_self", label: "Öz savunma modu", fields: ["mode"], category: "Dövüş" },
  { type: "set_defend", label: "Savunma ayarla", fields: ["mode"], category: "Dövüş" },
  { type: "equip_best", label: "En iyi silahı kuşan", fields: [], category: "Dövüş" },
  { type: "loot_death", label: "Ölüm loot noktasına git", fields: [], category: "Dövüş" },
  { type: "eat", label: "Ye", fields: [], category: "Yaşam" },
  { type: "hunt", label: "Avlan", fields: ["radius"], category: "Yaşam" },
  { type: "cook", label: "Pişir", fields: [], category: "Yaşam" },
  { type: "acquire_food", label: "Yemek edin", fields: [], category: "Yaşam" },
  {
    type: "collect",
    label: "Eşya/blok topla (dünya)",
    fields: ["item", "block", "count"],
    category: "İş"
  },
  {
    type: "collect_item",
    label: "Belirli eşyayı topla",
    fields: ["item", "count"],
    category: "İş"
  },
  { type: "mine", label: "Maden topla", fields: ["ore", "count", "mode"], category: "İş" },
  { type: "craft", label: "Üret", fields: ["item", "count"], category: "İş" },
  { type: "collect_drops", label: "Yerdeki eşya", fields: ["filter", "radius"], category: "İş" },
  { type: "deposit", label: "Depoya bırak", fields: ["filter"], category: "İş" },
  { type: "withdraw", label: "Depodan al", fields: ["item", "count"], category: "İş" }
];

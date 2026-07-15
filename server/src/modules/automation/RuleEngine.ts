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
  | "item_count";

export interface RuleTrigger {
  type: TriggerType;
  pattern?: string; // chat
  match?: "exact" | "contains" | "regex";
  from?: "authorized" | "anyone" | string[];
  threshold?: number;
  item?: string;
  comparison?: "lt" | "lte" | "gt" | "gte" | "eq";
  everyMs?: number;
}

export interface RuleCondition {
  type: "has_item" | "task_idle" | "health_below" | "food_below" | "in_dimension";
  item?: string;
  threshold?: number;
  dimension?: string;
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

/**
 * Otomasyon motoru (Faz 11). Hatalı kural motoru çökertmez.
 */
export class RuleEngine {
  rules: AutomationRule[] = [];
  private lastFire = new Map<string, number>();
  private minuteHits = new Map<string, number[]>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private dryRun = false;

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

  /** test: run actions as log-only */
  async testRule(id: string, botId: string) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error("Kural bulunamadı");
    const prev = this.dryRun;
    this.dryRun = true;
    try {
      await this.execute(rule, botId, { player: "Test", text: "test", arg: "" });
    } finally {
      this.dryRun = prev;
    }
  }

  onChat(botId: string, username: string | undefined, text: string) {
    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger.type !== "chat") continue;
      if (!this.appliesToBot(rule, botId)) continue;
      try {
        if (!this.matchChat(rule, username, text)) continue;
        if (!this.rateOk(rule)) continue;
        if (!this.conditionsOk(rule, botId)) continue;
        void this.execute(rule, botId, { player: username ?? "", text, arg: extractArg(rule.trigger.pattern, text) });
      } catch (e) {
        log.error(`Kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
        rule.enabled = false;
        this.persist();
      }
    }
  }

  onVitals(botId: string, health: number, food: number) {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!this.appliesToBot(rule, botId)) continue;
      try {
        if (rule.trigger.type === "health_below" && health <= (rule.trigger.threshold ?? 6)) {
          if (this.rateOk(rule) && this.conditionsOk(rule, botId)) void this.execute(rule, botId, {});
        }
        if (rule.trigger.type === "food_below" && food <= (rule.trigger.threshold ?? 6)) {
          if (this.rateOk(rule) && this.conditionsOk(rule, botId)) void this.execute(rule, botId, {});
        }
      } catch (e) {
        log.error(`Kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  onBotEvent(botId: string, kind: "spawned" | "died") {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!this.appliesToBot(rule, botId)) continue;
      const t = kind === "spawned" ? "bot_spawned" : "bot_died";
      if (rule.trigger.type !== t) continue;
      try {
        if (this.rateOk(rule) && this.conditionsOk(rule, botId)) void this.execute(rule, botId, {});
      } catch (e) {
        log.error(`Kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
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
            if (this.rateOk(rule) && this.conditionsOk(rule, botId)) void this.execute(rule, botId, {});
          } catch (e) {
            log.error(`Interval kural hata (${rule.name})`, e instanceof Error ? e.message : String(e));
          }
        }
      }, ms);
      this.intervals.set(rule.id, timer);
    }
  }

  private appliesToBot(rule: AutomationRule, botId: string) {
    return rule.botIds === "all" || rule.botIds.includes(botId);
  }

  private matchChat(rule: AutomationRule, username: string | undefined, text: string): boolean {
    const tr = rule.trigger;
    const from = tr.from ?? "authorized";
    const inst = this.manager.get(rule.botIds === "all" ? "" : "");
    void inst;
    // authorization
    if (from === "authorized") {
      // check any bot in scope's authorized list
      const bots =
        rule.botIds === "all" ? [...this.manager.bots.values()] : rule.botIds.map((id) => this.manager.get(id)).filter(Boolean);
      const allowed = bots.some((b) => b && username && b.config.authorizedPlayers.map((x) => x.toLowerCase()).includes(username.toLowerCase()));
      if (!allowed) return false;
    } else if (Array.isArray(from)) {
      if (!username || !from.map((x) => x.toLowerCase()).includes(username.toLowerCase())) return false;
    }
    const pat = tr.pattern ?? "";
    const mode = tr.match ?? "contains";
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
      if (c.type === "task_idle" && inst.tasks.currentSummary) return false;
      if (c.type === "health_below" && inst.runtime.health > (c.threshold ?? 10)) return false;
      if (c.type === "food_below" && inst.runtime.food > (c.threshold ?? 10)) return false;
      if (c.type === "in_dimension" && c.dimension && inst.runtime.dimension !== c.dimension) return false;
      if (c.type === "has_item" && c.item) {
        const inv = inst.getSnapshot().inventory;
        const ok = inv?.slots.some((s) => s && s.name.includes(c.item!));
        if (!ok) return false;
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
      // emit via logger success/info
      const level = String(action.level ?? "info");
      const msg = interpolate(String(action.message ?? ""), ctx);
      if (level === "error") log.error(msg);
      else if (level === "success") log.success(msg);
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
    if (type === "flee") {
      inst.combat.enqueueFlee();
      return;
    }
    if (type === "defend_self") {
      inst.config.combat.defendMode = "all";
      return;
    }
    if (type === "attack") {
      const target = interpolate(String(action.target ?? action.player ?? ctx.player ?? ""), ctx);
      if (target) inst.combat.enqueueAttackPlayer(target);
      return;
    }
    if (type === "follow") {
      const p = interpolate(String(action.player ?? ctx.player ?? ""), ctx);
      if (p) inst.enqueueAction({ type: "follow", player: p });
      return;
    }
    if (type === "goto") {
      if (action.waypoint) {
        inst.enqueueAction({ type: "goto-waypoint", waypointId: action.waypoint });
      } else if (action.player || ctx.player) {
        inst.enqueueAction({ type: "goto-player", player: String(action.player ?? ctx.player) });
      } else if (action.x != null) {
        inst.enqueueAction({ type: "goto", x: action.x, y: action.y, z: action.z });
      }
      return;
    }
    if (type === "collect") {
      inst.gather.enqueueCollectWood(Number(action.count ?? 16), action.block ? String(action.block) : undefined);
      return;
    }
    if (type === "mine") {
      inst.gather.enqueueMine(String(action.ore ?? "iron"), Number(action.count ?? 8));
      return;
    }
    if (type === "craft") {
      inst.craft.enqueueCraft(String(action.item ?? "stick"), Number(action.count ?? 1));
      return;
    }
    // generic action passthrough
    inst.enqueueAction({ ...action, type });
  }
}

function interpolate(s: string, ctx: Record<string, string>) {
  return s.replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? "");
}

function extractArg(pattern: string | undefined, text: string): string {
  if (!pattern) return "";
  const idx = text.toLowerCase().indexOf(pattern.toLowerCase());
  if (idx < 0) return "";
  return text.slice(idx + pattern.length).trim();
}

export const RULE_TEMPLATES: Array<Partial<AutomationRule>> = [
  {
    name: "Gel komutu",
    trigger: { type: "chat", pattern: "gel", match: "contains", from: "authorized" },
    actions: [{ type: "goto", player: "{player}" }, { type: "panel_notify", message: "{player} için gel", level: "info" }],
    cooldownMs: 2000
  },
  {
    name: "Beni koru",
    trigger: { type: "chat", pattern: "koru", match: "contains", from: "authorized" },
    actions: [{ type: "defend_self" }, { type: "panel_notify", message: "Savunma: hepsi", level: "success" }]
  },
  {
    name: "Oduncu",
    trigger: { type: "interval", everyMs: 120_000 },
    conditions: [{ type: "task_idle" }],
    actions: [{ type: "collect", count: 16 }]
  },
  {
    name: "Yemek nöbetçisi",
    trigger: { type: "food_below", threshold: 10 },
    actions: [{ type: "eat" }]
  },
  {
    name: "Hoş geldin",
    trigger: { type: "chat", pattern: "sa", match: "contains", from: "anyone" },
    actions: [{ type: "send_chat", text: "as {player}" }],
    cooldownMs: 10000,
    maxTriggersPerMinute: 3
  }
];

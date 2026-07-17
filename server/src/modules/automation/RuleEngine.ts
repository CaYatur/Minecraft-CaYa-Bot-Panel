import { loadJson, saveJson } from "../../persistence/store";
import type { BotManager } from "../../core/BotManager";
import { createLogger } from "../../utils/logger";
import { newId, type TaskSummary } from "../../types";
import { findBlueprint, RULE_BLUEPRINTS, type RuleBlueprint } from "./blueprints";
import {
  defaultConditionGroup,
  newFlowNodeId,
  type AutomationActionNode,
  type AutomationConditionGroup,
  type AutomationConditionNode,
  type AutomationNode,
  type AutomationPrimitive,
  type AutomationRunPolicy
} from "./flow.js";

const FILE = "rules.json";
const log = createLogger("rules");

type AutomationContext = Record<string, unknown>;

interface AutomationActionResult {
  ok: boolean;
  actionType: string;
  status: "completed" | "queued" | "done" | "failed" | "cancelled" | "timeout";
  taskId?: string;
  taskType?: string;
  label?: string;
  error?: string;
  progressDone?: number;
  progressTotal?: number;
}

interface FlowRunState {
  startedAt: number;
  deadline: number;
  maxSteps: number;
  steps: number;
  stopped: boolean;
  botId: string;
  cancelGeneration: number;
  stopResult?: "success" | "failed";
  stopMessage?: string;
}

export type TriggerType =
  | "chat"
  | "health_below"
  | "food_below"
  | "interval"
  | "bot_spawned"
  | "bot_died"
  | "item_count"
  /** inventorye yeni eşya geldi / adet arttı */
  | "item_gained"
  | "attacked"
  | "player_nearby"
  /** oyuncu menzil DIŞINDA (uzak) — radius'tan fazla veya not visible */
  | "player_far"
  /** takip edilen oyuncu takip distancesinin / radius dışına çıktı */
  | "follow_out_of_range"
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
  /** slash komut öneki (varsayılan "/") — "!gel" for "!" */
  commandPrefix?: string;
}

export interface RuleCondition {
  type:
    | "has_item"
    | "not_has_item"
    | "task_idle"
    | "task_busy"
    /** Aktif görev tipi: mine | gather | craft | none… */
    | "task_is"
    /** Aktif görev etiketi (label) eşleşmesi */
    | "task_label_is"
    /** Dövüş / companion modu: idle | attacking | following… */
    | "combat_mode_is"
    /** Followed player adı eşleşmesi */
    | "follow_player_is"
    /** Bot bağlantı durumu: online | stopped… */
    | "status_is"
    | "health_below"
    | "health_above"
    | "food_below"
    | "food_above"
    | "in_dimension"
    | "online"
    | "offline"
    | "player_near"
    | "player_far"
    | "following"
    | "not_following"
    | "item_count"
    | "time_day"
    | "time_night";
  item?: string;
  threshold?: number;
  dimension?: string;
  player?: string;
  radius?: number;
  comparison?: "lt" | "lte" | "gt" | "gte" | "eq";
  /** task_is / task_done tarzı: görev tipi (mine, craft, none…) — | ile VEYA listesi */
  taskType?: string;
  /** Genel string target (etiket, mod, status…) — taskType yoksa burası */
  value?: string;
  /**
   * String eşleşme:
   * eq (varsayılan) | neq | contains | startsWith | regex
   * eq/neq/contains/startsWith: value forde | ile VEYA (mine|gather)
   */
  match?: "eq" | "neq" | "contains" | "startsWith" | "regex";
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
  /** IF koşulları doğruysa */
  actions: RuleAction[];
  /**
   * ELSE: tetik oldu ama IF koşulları tutmadıysa (tek dal — opsiyonel).
   * Boşsa hiçbir şey yapılmaz.
   */
  elseActions?: RuleAction[];
  /**
   * HATA: THEN aksiyonlarından biri hata verirse çalışır (tek blok — opsiyonel).
   * ctx.error ile hata mesajı gelir.
   */
  onErrorActions?: RuleAction[];
  /** Gelişmiş, iç içe akış. Varsa legacy conditions/actions yerine çalışır. */
  flow?: AutomationNode[];
  /** Her çalışmanın başında context'e eklenen kullanıcı değişkenleri. */
  variables?: Record<string, AutomationPrimitive>;
  runPolicy?: AutomationRunPolicy;
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
  /** ruleId:botId -> çalışan gelişmiş akış sayısı */
  private activeRuns = new Map<string, number>();
  /** Her bot for aktif otomasyon akışlarını topluca geçersiz kılan nesil sayacı. */
  private botCancelGeneration = new Map<string, number>();
  /** Kullanıcı "tümünü cancelled" dediğinde aynı kuralın anında yeniden görev üretmesini engeller. */
  private automationSuppressedUntil = new Map<string, number>();

  constructor(private readonly manager: BotManager) {}

  load() {
    this.rules = loadJson<AutomationRule[]>(FILE, []).map(normalizeAutomationRule);
    this.rewireIntervals();
    log.info(`${this.rules.length} automation rule(s) loaded`);
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
      name: partial.name || "New rule",
      enabled: partial.enabled ?? true,
      botIds: partial.botIds ?? "all",
      trigger: partial.trigger ?? { type: "chat", pattern: "gel", match: "contains", from: "authorized" },
      conditions: partial.conditions ?? [],
      actions: partial.actions ?? [{ type: "panel_notify", message: "Rule triggered", level: "info" }],
      elseActions: partial.elseActions ?? [],
      onErrorActions: partial.onErrorActions ?? [],
      flow: partial.flow ? prepareFlow(partial.flow) : undefined,
      variables: partial.variables ?? {},
      runPolicy: partial.runPolicy ?? { concurrency: "skip", maxRuntimeMs: 600_000, maxSteps: 500 },
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
    if (!r) throw new Error("Rule not found");
    const normalizedPatch: Partial<AutomationRule> & { flow?: AutomationNode[] } = { ...patch };
    const rawFlow = (patch as Partial<AutomationRule> & { flow?: AutomationNode[] | null }).flow;
    if (Array.isArray(rawFlow)) normalizedPatch.flow = prepareFlow(rawFlow);
    else if (rawFlow === null) normalizedPatch.flow = undefined;
    Object.assign(r, normalizedPatch, { id: r.id });
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
    if (!rule) throw new Error("Rule not found");
    const prev = this.dryRun;
    this.dryRun = true;
    try {
      await this.execute(rule, botId, { player: "Test", text: "test", arg: "", attacker: "Test", ore: "iron", item: "stick" });
    } finally {
      this.dryRun = prev;
    }
  }

  onChat(botId: string, username: string | undefined, text: string) {
    // Ignore the bot's own username (defense in depth; BotManager also filters self)
    if (this.isOwnUsername(botId, username)) {
      log.debug("Chat ignored (own message)", `bot=${botId} · ${username}: ${String(text).slice(0, 80)}`);
      return;
    }
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!this.appliesToBot(rule, botId)) continue;
      if (rule.trigger.type !== "chat") continue;
      try {
        const hit = this.matchChatDetailed(rule, botId, username, text);
        if (!hit) continue;
        this.tryFire(rule, botId, { player: username ?? "", text, ...hit });
      } catch (e) {
        log.error(`Rule error (${rule.name})`, e instanceof Error ? e.message : String(e));
        rule.enabled = false;
        this.persist();
      }
    }
  }

  /** Bot's own Minecraft username? (follow/attack/chat self-loops) */
  private isOwnUsername(botId: string, name: string | undefined | null): boolean {
    if (!name?.trim()) return false;
    const inst = this.manager.get(botId);
    if (!inst) return false;
    const n = name.trim().toLowerCase();
    const cfg = inst.config.username?.toLowerCase();
    if (cfg && n === cfg) return true;
    try {
      const live = inst.bot?.username?.toLowerCase();
      if (live && n === live) return true;
    } catch {
      /* */
    }
    return false;
  }

  onVitals(botId: string, health: number, food: number) {
    const ctx = { health: String(health), food: String(food) };
    this.fireMatching(
      botId,
      "health_below",
      ctx,
      (rule) => rule.trigger.type === "health_below" && health <= (rule.trigger.threshold ?? 6)
    );
    this.fireMatching(
      botId,
      "food_below",
      ctx,
      (rule) => rule.trigger.type === "food_below" && food <= (rule.trigger.threshold ?? 6)
    );
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

  onTaskEvent(
    botId: string,
    kind: "done" | "failed",
    taskType: string,
    label: string,
    result?: {
      taskId?: string;
      state?: string;
      error?: string;
      progress?: { done: number; total: number; label?: string };
    }
  ) {
    const t = kind === "done" ? "task_done" : "task_failed";
    this.fireMatching(
      botId,
      t,
      {
        taskType,
        label,
        task: taskType,
        taskLabel: label,
        status: kind,
        taskStatus: result?.state ?? kind,
        taskId: result?.taskId ?? "",
        taskError: result?.error ?? "",
        taskProgressDone: String(result?.progress?.done ?? 0),
        taskProgressTotal: String(result?.progress?.total ?? 0),
        taskProgressLabel: result?.progress?.label ?? ""
      },
      (rule) => {
        if (rule.trigger.type !== t) return false;
        const want = (rule.trigger.taskType ?? "").trim();
        if (!want) return true;
        // "collect-wood|collect-block|mine" veya tek tip; includes eşleşmesi
        const aliases = want.split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);
        const got = taskType.toLowerCase();
        return aliases.some((a) => got === a || got.includes(a) || a.includes(got));
      }
    );
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
        this.tryFire(rule, botId, { item, count: String(count) });
      } catch (e) {
        log.error(`item_count rule error (${rule.name})`, e instanceof Error ? e.message : String(e));
      }
    }
    // inventorye yeni eşya / adet artışı
    this.onItemGainedTick(botId);
  }

  /**
   * Inventory has insufficient belirli eşyanın adedi arttıysa (toplama/loot/craft sonucu).
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
    // ilk snapshot — tetikleme (yanlış “allni aldı” spam’i olmasın)
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
        this.tryFire(rule, botId, {
          item: hit.item,
          count: String(hit.count),
          delta: String(hit.delta),
          gained: hit.item
        });
      } catch (e) {
        log.error(`item_gained rule error (${rule.name})`, e instanceof Error ? e.message : String(e));
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
        this.tryFire(rule, botId, ctx);
      } catch (e) {
        log.error(`Rule error (${rule.name})`, e instanceof Error ? e.message : String(e));
        rule.enabled = false;
        this.persist();
      }
    }
  }

  /**
   * Tetik eşleşti → rate limit → IF/ELSE.
   * IF tutmazsa elseActions (varsa); THEN hata verirse onErrorActions.
   * Her ateşte canlı bot durumu (görev, takip, can…) context’e eklenir → {task} sohbette de dolar.
   */
  private tryFire(rule: AutomationRule, botId: string, ctx: Record<string, string>) {
    if (!this.rateOk(rule)) return;
    const full: AutomationContext = {
      ...this.liveBotContext(botId),
      ...(rule.variables ?? {}),
      ...ctx
    };

    if (rule.flow && rule.flow.length > 0) {
      void this.executeFlow(rule, botId, full);
      return;
    }

    const ok = this.conditionsOk(rule, botId, full);
    if (ok) {
      void this.execute(rule, botId, stringifyContext({ ...full, branch: "then" }), "then");
    } else if (rule.elseActions && rule.elseActions.length > 0) {
      void this.execute(rule, botId, stringifyContext({ ...full, branch: "else" }), "else");
    }
  }

  /**
   * Her kural çalışmasında kullanılabilir anlık bot durumu.
   * Sohbet “bot durum” + IF task_busy → THEN “Görev: {task} {label}” gibi senaryolar for.
   */
  private liveBotContext(botId: string): Record<string, string> {
    const inst = this.manager.get(botId);
    if (!inst) {
      return {
        task: "none",
        taskType: "none",
        label: "—",
        taskLabel: "—",
        taskState: "none",
        hasTask: "0",
        busy: "0",
        idle: "1",
        queueLength: "0",
        status: "unknown",
        health: "0",
        food: "0",
        combatMode: "idle",
        mode: "idle",
        activeTarget: "",
        followPlayer: "",
        followDistance: "0",
        protectPlayers: "",
        position: "",
        dimension: ""
      };
    }
    const cur = inst.tasks.currentSummary;
    const queue = inst.tasks.queueSummaries ?? [];
    const combat = inst.combat.getRuntime();
    const rt = inst.runtime;
    const pos = rt.position;
    const busy = Boolean(cur);
    return {
      // görev
      task: cur?.type ?? "none",
      taskType: cur?.type ?? "none",
      label: cur?.label ?? "—",
      taskLabel: cur?.label ?? "—",
      taskState: cur?.state ?? "idle",
      hasTask: busy ? "1" : "0",
      busy: busy ? "1" : "0",
      idle: busy ? "0" : "1",
      queueLength: String(queue.length),
      queueTypes: queue
        .slice(0, 5)
        .map((q) => q.type)
        .join(","),
      // bot
      bot: inst.config.username,
      botId: inst.config.id,
      status: inst.status,
      health: String(rt.health ?? 0),
      food: String(rt.food ?? 0),
      dimension: rt.dimension ?? "",
      position:
        pos != null
          ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
          : "",
      // combat / companion
      combatMode: combat.mode ?? "idle",
      mode: combat.mode ?? "idle",
      activeTarget: combat.activeTarget ?? "",
      followPlayer: combat.companion?.followPlayer ?? "",
      followDistance: String(combat.companion?.followDistance ?? 3),
      protectPlayers: (combat.companion?.protectPlayers ?? []).join(","),
      attacking: combat.mode === "attacking" ? "1" : "0",
      following: combat.companion?.followPlayer ? "1" : "0"
    };
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
            this.tryFire(rule, botId, {});
          } catch (e) {
            log.error(`Interval rule error (${rule.name})`, e instanceof Error ? e.message : String(e));
          }
        }
      }, ms);
      this.intervals.set(rule.id, timer);
    }

    // item_count / item_gained polling
    const itemTimer = setInterval(() => {
      for (const id of this.manager.bots.keys()) this.onItemCountTick(id);
    }, 20_000);
    this.intervals.set("__item_count_poll__", itemTimer);

    // oyuncu uzak / takip menzil dışı — sık poll
    const distTimer = setInterval(() => {
      for (const id of this.manager.bots.keys()) this.onDistanceTick(id);
    }, 2_500);
    this.intervals.set("__distance_poll__", distTimer);
  }

  /**
   * player_far + follow_out_of_range tetikleri.
   * player boş veya @follow → companion takip targeti.
   */
  onDistanceTick(botId: string) {
    const inst = this.manager.get(botId);
    if (!inst || inst.status !== "online" || !inst.bot?.entity) return;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!this.appliesToBot(rule, botId)) continue;
      const t = rule.trigger.type;
      if (t !== "player_far" && t !== "follow_out_of_range") continue;

      try {
        const companion = inst.combat.getRuntime().companion;
        let playerName = String(rule.trigger.player ?? "").trim();
        if (!playerName || playerName === "@follow" || playerName === "{follow}") {
          playerName = companion?.followPlayer ?? "";
        }
        if (playerName === "@protect" || playerName === "{protect}") {
          playerName =
            companion?.protectPlayer ?? companion?.protectPlayers?.[0] ?? companion?.followPlayer ?? "";
        }

        if (t === "follow_out_of_range") {
          if (!companion?.followPlayer) continue;
          playerName = companion.followPlayer;
        }
        if (!playerName) continue;

        const dist = this.getPlayerDistance(botId, playerName);
        const followDist = Math.max(1, Number(companion?.followDistance ?? 3));
        // radius yoksa: takip distancesi + 4 blok tolerans
        const limit =
          rule.trigger.radius != null
            ? Number(rule.trigger.radius)
            : t === "follow_out_of_range"
              ? followDist + 4
              : 24;

        // not visible veya limitten uzak = far
        const isFar = dist == null || dist > limit;
        if (!isFar) continue;

        this.tryFire(rule, botId, {
          player: playerName,
          distance: dist != null ? String(Math.round(dist * 10) / 10) : "∞",
          radius: String(limit),
          followDistance: String(followDist)
        });
      } catch (e) {
        log.error(`Distance rule error (${rule.name})`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  /** Oyuncu distancesi; entity yoksa null (chunk dışı / çok uzak) */
  private getPlayerDistance(botId: string, playerName: string): number | null {
    const inst = this.manager.get(botId);
    const bot = inst?.bot;
    if (!bot?.entity || !playerName) return null;
    const want = playerName.toLowerCase();
    let ent = bot.players[playerName]?.entity;
    if (!ent) {
      for (const [n, p] of Object.entries(bot.players)) {
        if (n.toLowerCase() === want && p.entity) {
          ent = p.entity;
          break;
        }
      }
    }
    if (!ent?.position) return null;
    try {
      return bot.entity.position.distanceTo(ent.position);
    } catch {
      return null;
    }
  }

  private isFollowing(botId: string): boolean {
    const c = this.manager.get(botId)?.combat.getRuntime().companion;
    return Boolean(c?.followPlayer);
  }

  /** Aktif gelişmiş/legacy otomasyon akışlarını cancelled eder ve kısa süre yeni tetikleri susturur. */
  cancelRunsForBot(botId: string, reason = "automation cancelled", suppressMs = 5_000) {
    this.botCancelGeneration.set(botId, this.currentCancelGeneration(botId) + 1);
    this.automationSuppressedUntil.set(botId, Date.now() + Math.max(0, suppressMs));
    log.info(`Bot automations cancelled: ${botId}`, reason);
  }

  private currentCancelGeneration(botId: string): number {
    return this.botCancelGeneration.get(botId) ?? 0;
  }

  private assertRunActive(botId: string, generation: number) {
    if (this.currentCancelGeneration(botId) !== generation) {
      throw new Error("Automation cancelled by user");
    }
  }

  private appliesToBot(rule: AutomationRule, botId: string) {
    const suppressed = (this.automationSuppressedUntil.get(botId) ?? 0) > Date.now();
    if (suppressed) return false;
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

    if (!pat && mode !== "exact") return {}; // empty pattern = every message
    if (mode === "exact") return raw === pat ? {} : null;
    if (mode === "startsWith") return lower.startsWith(pat.toLowerCase()) ? {} : null;
    if (mode === "regex") {
      try {
        return new RegExp(pat, "i").test(raw) ? {} : null;
      } catch {
        throw new Error(`Invalid regex: ${pat}`);
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

  private conditionsOk(rule: AutomationRule, botId: string, ctx: AutomationContext = {}): boolean {
    return (rule.conditions ?? []).every((condition) => this.conditionOk(condition, botId, ctx));
  }

  private conditionOk(c: RuleCondition, botId: string, ctx: AutomationContext): boolean {
    const inst = this.manager.get(botId);
    if (!inst) return false;
    if (c.type === "online") return inst.status === "online";
    if (c.type === "offline") return inst.status !== "online";
    if (c.type === "task_idle") return !inst.tasks.currentSummary;
    if (c.type === "task_busy") return Boolean(inst.tasks.currentSummary);
    if (c.type === "task_is") {
      const actual = inst.tasks.currentSummary?.type ?? "none";
      const expected = String(c.taskType ?? c.value ?? c.item ?? "").trim();
      return Boolean(expected) && stringMatches(actual, interpolateValue(expected, ctx), c.match ?? "eq");
    }
    if (c.type === "task_label_is") {
      const actual = inst.tasks.currentSummary?.label ?? "";
      const expected = String(c.value ?? c.taskType ?? c.item ?? "").trim();
      return Boolean(expected) && stringMatches(actual, interpolateValue(expected, ctx), c.match ?? "contains");
    }
    if (c.type === "combat_mode_is") {
      const actual = String(inst.combat.getRuntime().mode ?? "idle");
      const expected = String(c.value ?? c.taskType ?? "").trim();
      return Boolean(expected) && stringMatches(actual, interpolateValue(expected, ctx), c.match ?? "eq");
    }
    if (c.type === "follow_player_is") {
      const actual = String(inst.combat.getRuntime().companion?.followPlayer ?? "");
      const expected = String(c.player ?? c.value ?? "").trim();
      return Boolean(expected) && stringMatches(actual, interpolateValue(expected, ctx), c.match ?? "eq");
    }
    if (c.type === "status_is") {
      const actual = String(inst.status ?? "");
      const expected = String(c.value ?? c.taskType ?? "").trim();
      return Boolean(expected) && stringMatches(actual, interpolateValue(expected, ctx), c.match ?? "eq");
    }
    if (c.type === "health_below") return inst.runtime.health <= (c.threshold ?? 10);
    if (c.type === "health_above") return inst.runtime.health >= (c.threshold ?? 10);
    if (c.type === "food_below") return inst.runtime.food <= (c.threshold ?? 10);
    if (c.type === "food_above") return inst.runtime.food >= (c.threshold ?? 10);
    if (c.type === "in_dimension") {
      return !c.dimension || inst.runtime.dimension === interpolateValue(c.dimension, ctx);
    }
    if (c.type === "has_item") {
      const item = interpolateValue(String(c.item ?? ""), ctx);
      return Boolean(item) && countItem(inst, item) > 0;
    }
    if (c.type === "not_has_item") {
      const item = interpolateValue(String(c.item ?? ""), ctx);
      return Boolean(item) && countItem(inst, item) <= 0;
    }
    if (c.type === "item_count") {
      const item = interpolateValue(String(c.item ?? ""), ctx);
      return Boolean(item) && compare(countItem(inst, item), c.comparison ?? "gte", c.threshold ?? 1);
    }
    if (c.type === "player_near" || c.type === "player_far") {
      const rawName = c.player?.trim() || inst.combat.getRuntime().companion?.followPlayer || "";
      const name = interpolateValue(rawName, ctx);
      if (!name) return false;
      const distance = this.getPlayerDistance(botId, name);
      const limit = c.radius ?? 16;
      return c.type === "player_near"
        ? distance != null && distance <= limit
        : distance == null || distance > limit;
    }
    if (c.type === "following") return this.isFollowing(botId);
    if (c.type === "not_following") return !this.isFollowing(botId);
    if (c.type === "time_day" || c.type === "time_night") {
      const bot = inst.bot;
      if (!bot) return false;
      const time = ((bot.time?.timeOfDay ?? 0) % 24000 + 24000) % 24000;
      const isDay = time >= 0 && time < 12000;
      return c.type === "time_day" ? isDay : !isDay;
    }
    return false;
  }

  private conditionGroupOk(group: AutomationConditionGroup, botId: string, ctx: AutomationContext): boolean {
    const values = group.items.map((item) => this.conditionNodeOk(item, botId, ctx));
    if (group.operator === "any") return values.some(Boolean);
    if (group.operator === "not") return !values.every(Boolean);
    return values.every(Boolean);
  }

  private conditionNodeOk(node: AutomationConditionNode, botId: string, ctx: AutomationContext): boolean {
    if (node.kind === "group") return this.conditionGroupOk(node, botId, ctx);
    if (node.kind === "bot") return this.conditionOk(node.condition, botId, ctx);
    return compareContextValues(
      resolveContextExpression(node.left, ctx),
      node.operator,
      resolveContextExpression(node.right, ctx)
    );
  }

  private async executeFlow(rule: AutomationRule, botId: string, initial: AutomationContext) {
    const key = `${rule.id}:${botId}`;
    const policy = {
      concurrency: rule.runPolicy?.concurrency ?? "skip",
      maxRuntimeMs: clampNumber(rule.runPolicy?.maxRuntimeMs, 1_000, 3_600_000, 600_000),
      maxSteps: clampNumber(rule.runPolicy?.maxSteps, 1, 5_000, 500)
    } as const;
    const running = this.activeRuns.get(key) ?? 0;
    if (policy.concurrency === "skip" && running > 0) {
      log.warn(`Rule skipped (still running): ${rule.name}`, `bot=${botId}`);
      return;
    }
    this.activeRuns.set(key, running + 1);

    const ctx: AutomationContext = { ...initial };
    for (const [name, value] of Object.entries(initial)) ctx[`event.${name}`] = value;
    ctx.runId = newId();
    ctx.ruleId = rule.id;
    ctx.ruleName = rule.name;
    const state: FlowRunState = {
      startedAt: Date.now(),
      deadline: Date.now() + policy.maxRuntimeMs,
      maxSteps: policy.maxSteps,
      steps: 0,
      stopped: false,
      botId,
      cancelGeneration: this.currentCancelGeneration(botId)
    };

    log.info(`Advanced rule trigger: ${rule.name}`, `bot=${botId} · nodes=${rule.flow?.length ?? 0}`);
    try {
      await this.executeNodes(rule.flow ?? [], rule, botId, ctx, state);
      if (state.stopResult === "failed") throw new Error(state.stopMessage || "Flow stopped as failed");
      log.success(`Advanced rule completed: ${rule.name}`, `steps=${state.steps}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelledByUser = this.currentCancelGeneration(botId) !== state.cancelGeneration;
      if (cancelledByUser) {
        log.info(`Advanced rule stopped by user: ${rule.name}`, `bot=${botId}`);
        return;
      }
      ctx.error = message;
      ctx.failedAction = String(ctx.failedAction ?? ctx.lastAction ?? "flow");
      log.error(`Advanced rule error (${rule.name})`, message);
      if (rule.onErrorActions?.length) {
        for (const action of rule.onErrorActions) {
          try {
            await this.runAction(botId, action, stringifyContext(ctx));
          } catch (nested) {
            log.error(
              `Advanced onError action error (${action.type})`,
              nested instanceof Error ? nested.message : String(nested)
            );
          }
        }
      }
    } finally {
      const left = Math.max(0, (this.activeRuns.get(key) ?? 1) - 1);
      if (left === 0) this.activeRuns.delete(key);
      else this.activeRuns.set(key, left);
    }
  }

  private async executeNodes(
    nodes: AutomationNode[],
    rule: AutomationRule,
    botId: string,
    ctx: AutomationContext,
    state: FlowRunState
  ): Promise<void> {
    for (const node of nodes) {
      if (state.stopped) return;
      this.assertFlowBudget(state);
      if (node.disabled) continue;
      state.steps += 1;
      ctx.nodeId = node.id;
      ctx.nodeType = node.type;
      this.refreshLiveContext(botId, ctx);

      if (node.type === "action") {
        await this.executeActionNode(node, rule, botId, ctx, state);
        continue;
      }
      if (node.type === "if") {
        const matched = this.conditionGroupOk(node.condition, botId, ctx);
        ctx.branch = matched ? "then" : "else";
        await this.executeNodes(matched ? node.then : node.else ?? [], rule, botId, ctx, state);
        continue;
      }
      if (node.type === "set") {
        const name = normalizeVariableName(node.name);
        if (!name) throw new Error("Variable name empty or invalid");
        ctx[name] = resolveContextExpression(node.value, ctx);
        ctx.lastVariable = name;
        ctx.lastValue = ctx[name];
        continue;
      }
      if (node.type === "wait") {
        if (node.until) {
          const timeout = clampNumber(node.timeoutMs, 100, 3_600_000, 30_000);
          const poll = clampNumber(node.pollMs, 50, 60_000, 250);
          const deadline = Math.min(state.deadline, Date.now() + timeout);
          while (!this.conditionGroupOk(node.until, botId, ctx)) {
            if (Date.now() >= deadline) throw new Error(`Condition wait timed out (${timeout} ms)`);
            await sleep(poll);
            this.assertFlowBudget(state);
            this.refreshLiveContext(botId, ctx);
          }
        } else {
          const ms = clampNumber(Number(node.seconds ?? 1) * 1000, 0, 3_600_000, 1_000);
          const waitUntil = Date.now() + ms;
          while (Date.now() < waitUntil) {
            this.assertFlowBudget(state);
            await sleep(Math.min(200, Math.max(0, waitUntil - Date.now())));
          }
        }
        continue;
      }
      if (node.type === "repeat") {
        const maxIterations = clampNumber(node.maxIterations, 1, 1_000, 100);
        const requested = node.times == null
          ? maxIterations
          : Number(resolveContextExpression(node.times, ctx));
        const iterations = Math.min(maxIterations, Math.max(0, Number.isFinite(requested) ? Math.floor(requested) : 0));
        for (let index = 0; index < iterations; index += 1) {
          this.assertFlowBudget(state);
          this.refreshLiveContext(botId, ctx);
          if (node.while && !this.conditionGroupOk(node.while, botId, ctx)) break;
          ctx.loopIndex = index;
          ctx.loopNumber = index + 1;
          await this.executeNodes(node.body, rule, botId, ctx, state);
          if (state.stopped) break;
        }
        continue;
      }
      if (node.type === "stop_flow") {
        state.stopped = true;
        state.stopResult = node.result ?? "success";
        state.stopMessage = interpolateValue(String(node.message ?? ""), ctx);
      }
    }
  }

  private async executeActionNode(
    node: AutomationActionNode,
    rule: AutomationRule,
    botId: string,
    ctx: AutomationContext,
    state: FlowRunState
  ) {
    const retries = clampNumber(node.retries, 0, 10, 0);
    const timeoutMs = clampNumber(node.timeoutMs, 100, 3_600_000, 120_000);
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      this.assertFlowBudget(state);
      ctx.attempt = attempt + 1;
      try {
        const action = interpolateRecord(node.action, ctx) as RuleAction;
        const result = await withTimeout(
          this.runActionWithResult(
            botId,
            action,
            ctx,
            node.waitForTask === true,
            timeoutMs,
            state.cancelGeneration
          ),
          timeoutMs,
          `Action timeout: ${String(action.type)}`
        );
        this.storeActionResult(ctx, node.saveAs, result);
        if (!result.ok) throw new Error(result.error || `Action failed: ${result.actionType}`);
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        ctx.error = message;
        ctx.failedAction = String(node.action.type);
        ctx.failedNode = node.id;
        if (attempt < retries) {
          await sleep(clampNumber(node.retryDelayMs, 0, 60_000, 500));
          continue;
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown action error");
    const failed: AutomationActionResult = {
      ok: false,
      actionType: String(node.action.type),
      status: "failed",
      error: message
    };
    this.storeActionResult(ctx, node.saveAs, failed);
    if (node.onError?.length) await this.executeNodes(node.onError, rule, botId, ctx, state);
    if (!node.continueOnError) throw new Error(message);
  }

  private async runActionWithResult(
    botId: string,
    action: RuleAction,
    ctx: AutomationContext,
    waitForTask: boolean,
    timeoutMs: number,
    cancelGeneration: number
  ): Promise<AutomationActionResult> {
    const inst = this.manager.get(botId);
    if (!inst) throw new Error("Bot not found");
    const before = new Set(this.allTaskSummaries(inst).map((task) => task.id));
    await this.runAction(botId, action, stringifyContext(ctx));
    const created = this.allTaskSummaries(inst).find((task) => !before.has(task.id));
    if (!created) {
      return { ok: true, actionType: String(action.type), status: "completed" };
    }
    if (!waitForTask) return this.taskResult(String(action.type), created);
    const finalTask = await this.waitForTask(inst, created.id, timeoutMs, botId, cancelGeneration);
    return this.taskResult(String(action.type), finalTask);
  }

  private allTaskSummaries(inst: NonNullable<ReturnType<BotManager["get"]>>): TaskSummary[] {
    return [
      ...(inst.tasks.currentSummary ? [inst.tasks.currentSummary] : []),
      ...inst.tasks.queueSummaries,
      ...inst.tasks.historySummaries.slice().reverse()
    ];
  }

  private async waitForTask(
    inst: NonNullable<ReturnType<BotManager["get"]>>,
    taskId: string,
    timeoutMs: number,
    botId: string,
    cancelGeneration: number
  ): Promise<TaskSummary> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertRunActive(botId, cancelGeneration);
      const task = this.allTaskSummaries(inst).find((item) => item.id === taskId);
      if (task && ["done", "failed", "cancelled"].includes(task.state)) return task;
      await sleep(100);
    }
    return { id: taskId, type: "unknown", label: "timeout", state: "failed", error: "timeout" };
  }

  private taskResult(actionType: string, task: TaskSummary): AutomationActionResult {
    const status = task.error === "timeout"
      ? "timeout"
      : task.state === "done"
        ? "done"
        : task.state === "failed"
          ? "failed"
          : task.state === "cancelled"
            ? "cancelled"
            : "queued";
    return {
      ok: status === "done" || status === "queued",
      actionType,
      status,
      taskId: task.id,
      taskType: task.type,
      label: task.label,
      error: task.error,
      progressDone: task.progress?.done,
      progressTotal: task.progress?.total
    };
  }

  private storeActionResult(ctx: AutomationContext, saveAs: string | undefined, result: AutomationActionResult) {
    const names = ["last", normalizeVariableName(saveAs ?? "")].filter(Boolean);
    for (const name of names) {
      ctx[`${name}.ok`] = result.ok;
      ctx[`${name}.status`] = result.status;
      ctx[`${name}.actionType`] = result.actionType;
      ctx[`${name}.taskId`] = result.taskId ?? "";
      ctx[`${name}.taskType`] = result.taskType ?? "";
      ctx[`${name}.label`] = result.label ?? "";
      ctx[`${name}.error`] = result.error ?? "";
      ctx[`${name}.progressDone`] = result.progressDone ?? 0;
      ctx[`${name}.progressTotal`] = result.progressTotal ?? 0;
    }
    ctx.lastAction = result.actionType;
    ctx.lastStatus = result.status;
    ctx.lastTaskId = result.taskId ?? "";
  }

  private refreshLiveContext(botId: string, ctx: AutomationContext) {
    const live = this.liveBotContext(botId);
    Object.assign(ctx, live);
    for (const [name, value] of Object.entries(live)) ctx[`live.${name}`] = value;
  }

  private assertFlowBudget(state: FlowRunState) {
    this.assertRunActive(state.botId, state.cancelGeneration);
    if (Date.now() > state.deadline) throw new Error("Automation exceeded max runtime");
    if (state.steps >= state.maxSteps) throw new Error("Automation exceeded max steps");
  }

  private async execute(
    rule: AutomationRule,
    botId: string,
    ctx: Record<string, string>,
    branch: "then" | "else" = "then"
  ) {
    const inst = this.manager.get(botId);
    if (!inst) return;
    const list =
      branch === "else"
        ? rule.elseActions ?? []
        : rule.actions ?? [];
    if (!list.length) return;
    const cancelGeneration = this.currentCancelGeneration(botId);

    log.info(
      `Rule trigger: ${rule.name}`,
      `bot=${inst.config.username} · ${branch === "else" ? "ELSE" : "THEN"}`
    );

    for (const action of list) {
      try {
        this.assertRunActive(botId, cancelGeneration);
        await this.runAction(inst.config.id, action, ctx);
        this.assertRunActive(botId, cancelGeneration);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (this.currentCancelGeneration(botId) !== cancelGeneration) {
          log.info(`Rule stopped by user: ${rule.name}`, `bot=${botId}`);
          break;
        }
        log.error(`Action error (${action.type})`, msg);
        // error during THEN → single onError block (once)
        if (branch === "then" && rule.onErrorActions && rule.onErrorActions.length > 0) {
          const errCtx = { ...ctx, error: msg, failedAction: String(action.type) };
          log.warn(`onError block: ${rule.name}`, msg);
          for (const errAct of rule.onErrorActions) {
            try {
              await this.runAction(inst.config.id, errAct, errCtx);
            } catch (e2) {
              log.error(
                `onError action error (${errAct.type})`,
                e2 instanceof Error ? e2.message : String(e2)
              );
            }
          }
        }
        break; // zinciri durdur
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
    // Tek aksiyonda bot durumu özeti (sohbet veya panel)
    if (type === "report_status" || type === "bot_status" || type === "durum-raporu") {
      const live = this.liveBotContext(botId);
      const merged = { ...live, ...ctx };
      const line =
        action.message != null && String(action.message).trim()
          ? interpolate(String(action.message), merged)
          : [
              `bot=${merged.bot}`,
              `status=${merged.status}`,
              `task=${merged.task}`,
              `label=${merged.label}`,
              `queue=${merged.queueLength}`,
              `hp=${merged.health}`,
              `food=${merged.food}`,
              `mode=${merged.combatMode}`,
              merged.followPlayer ? `follow=${merged.followPlayer}` : null,
              merged.activeTarget ? `target=${merged.activeTarget}` : null,
              merged.position ? `pos=${merged.position}` : null
            ]
              .filter(Boolean)
              .join(" · ");
      const dest = String(action.to ?? action.channel ?? "panel"); // panel | chat | both
      if (dest === "chat" || dest === "both") inst.sendChat(line);
      if (dest !== "chat") {
        log.info(`Status: ${line}`);
      }
      return;
    }
    if (type === "wait") {
      await new Promise((r) => setTimeout(r, Math.max(0, Number(action.seconds ?? 1) * 1000)));
      return;
    }
    if (type === "stop_tasks") {
      this.manager.cancelAllWork(botId, "automation stop_tasks");
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
      if (target && this.isOwnUsername(botId, target)) {
        log.warn("attack ignored: bot cannot attack self", target);
        return;
      }
      if (target) inst.combat.enqueueAttackPlayer(target);
      return;
    }
    if (type === "clear_mobs" || type === "clear-mobs") {
      inst.combat.enqueueClearMobs(Number(action.radius ?? 16));
      return;
    }
    if (type === "follow") {
      const p = interpolate(String(action.player ?? ctx.player ?? ""), ctx).trim();
      if (!p || p.startsWith("{")) {
        log.warn("follow ignored: empty player after interpolate");
        return;
      }
      if (this.isOwnUsername(botId, p)) {
        log.warn("follow ignored: bot cannot follow self", p);
        return;
      }
      inst.enqueueAction({ type: "follow", player: p, distance: Number(action.distance ?? 3) });
      return;
    }
    if (type === "goto") {
      if (action.waypoint) {
        // resolved in REST only — try manager waypoints by name
        const name = interpolate(String(action.waypoint), ctx).trim();
        const list = this.manager.waypoints.forServer(inst.config.serverId);
        const wp = list.find((w) => w.name.toLowerCase() === name.toLowerCase() || w.id === name);
        if (wp) inst.enqueueAction({ type: "goto", x: wp.x, y: wp.y, z: wp.z, label: `waypoint: ${wp.name}` });
      } else if (action.player || ctx.player) {
        const p = interpolate(String(action.player ?? ctx.player ?? ""), ctx).trim();
        if (!p || p.startsWith("{")) {
          log.warn("goto-player ignored: empty player after interpolate");
          return;
        }
        if (this.isOwnUsername(botId, p)) {
          log.warn("goto-player ignored: target is the bot itself", p);
          return;
        }
        inst.enqueueAction({ type: "goto-player", player: p });
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
        log.warn("collect: no item name", JSON.stringify(action));
        return;
      }
      const countMode = action.countMode === "target" ? "target" : "add";
      if (name.endsWith("_log") || name.endsWith("_stem") || name === "log") {
        inst.gather.enqueueCollectWood(n, name === "log" ? undefined : name, undefined, countMode);
      } else {
        inst.gather.enqueueCollectBlock(name, n, undefined, countMode);
      }
      return;
    }
    if (type === "collect_drops" || type === "eşya-topla") {
      inst.gather.enqueueCollectDrops(action.filter ? String(action.filter) : undefined, Number(action.radius ?? 16));
      return;
    }
    if (type === "mine" || type === "maden-topla") {
      const ore = interpolate(String(action.ore ?? ctx.ore ?? "iron"), ctx).replace(/_ore$/, "");
      const countMode = action.countMode === "target" ? "target" : "add";
      inst.gather.enqueueMine(
        ore,
        Number(action.count ?? 8),
        action.mode === "utility" ? "utility" : "legit",
        undefined,
        countMode
      );
      return;
    }
    if (type === "craft" || type === "üret") {
      inst.craft.enqueueCraft(interpolate(String(action.item ?? ctx.item ?? "stick"), ctx), Number(action.count ?? 1));
      return;
    }
    if (type === "deposit" || type === "depoya-bırak" || type === "depoya-drop") {
      inst.enqueueAction({
        type: "deposit",
        filter: action.filter != null ? interpolate(String(action.filter), ctx) : "",
        items: action.items,
        x: action.x,
        y: action.y,
        z: action.z
      });
      return;
    }
    if (type === "withdraw" || type === "depodan-al") {
      inst.enqueueAction({
        type: "withdraw",
        item: action.item ?? ctx.item,
        count: action.count ?? 1,
        x: action.x,
        y: action.y,
        z: action.z
      });
      return;
    }
    // ---- Faz 19 tarım (issue #5) — {var} interpolasyonlu alanlarla paylaşılan farm çekirdeği
    if (FARM_ACTION_KINDS[type]) {
      const numF = (v: unknown) => {
        if (v == null || v === "") return undefined;
        const n = Number(interpolate(String(v), ctx));
        return Number.isFinite(n) ? n : undefined;
      };
      inst.enqueueAction({
        type: FARM_ACTION_KINDS[type],
        x: numF(action.x),
        y: numF(action.y),
        z: numF(action.z),
        radius: numF(action.radius),
        maxBlocks: numF(action.maxBlocks),
        crop: action.crop != null && action.crop !== "" ? interpolate(String(action.crop), ctx) : undefined,
        replant: action.replant,
        till: action.till,
        depositX: numF(action.depositX),
        depositY: numF(action.depositY),
        depositZ: numF(action.depositZ),
        depositNearest: action.depositNearest,
        intervalSec: numF(action.intervalSec),
        maxCycles: numF(action.maxCycles)
      });
      return;
    }
    if (
      type === "drop_items" ||
      type === "drop-items" ||
      type === "discard_item" ||
      type === "discard-items" ||
      type === "eşya-at"
    ) {
      const item = interpolate(String(action.item ?? ctx.item ?? ""), ctx).replace(/^minecraft:/, "");
      const rawCount = interpolate(String(action.count ?? 1), ctx);
      inst.enqueueAction({
        type: "drop_items",
        item,
        count: Math.max(0, Number(rawCount) || 0),
        dropMode: action.dropMode === "all" || action.dropMode === "keep" ? action.dropMode : "count",
        match: action.match === "contains" ? "contains" : "exact",
        respectKeepItems: action.respectKeepItems !== false && action.respectKeepItems !== "false",
        failIfMissing: action.failIfMissing === true || action.failIfMissing === "true",
        requireCount: action.requireCount === true || action.requireCount === "true"
      });
      return;
    }
    if (type === "stop") {
      inst.enqueueAction({ type: "stop" });
      return;
    }
    // herhangi bir işi cancelled et (aktif görev + kuyruk + pathfinder; companion korunur)
    if (
      type === "cancel_work" ||
      type === "cancel_any" ||
      type === "işi-iptal" ||
      type === "cancel_current_work"
    ) {
      this.manager.cancelAllWork(botId, "automation: cancel work");
      return;
    }
    // sadece aktif görev
    if (
      type === "leave_task" ||
      type === "cancel_task" ||
      type === "görev-bırak" ||
      type === "görev-drop" ||
      type === "abort_current"
    ) {
      const cur = inst.tasks.currentSummary;
      if (cur) inst.tasks.cancel(cur.id, "automation: leave task");
      return;
    }
    if (type === "unfollow" || type === "cancel_follow" || type === "takip-cancelled") {
      const follow = inst.combat.getRuntime().companion?.followPlayer;
      const p = interpolate(String(action.player ?? follow ?? ctx.player ?? ""), ctx);
      if (p) {
        inst.enqueueAction({ type: "social-follow", player: p, enabled: false });
      } else {
        inst.combat.clearCompanion("automation unfollow");
      }
      // pathfinder da dursun
      inst.enqueueAction({ type: "stop" });
      return;
    }
    if (
      type === "abort_all" ||
      type === "cancel_all" ||
      type === "her-şeyi-bırak" ||
      type === "her-şeyi-drop" ||
      type === "leave_all"
    ) {
      // follow + combat companion + all tasks + pathfinder + active automation flows
      this.manager.cancelAllWork(botId, "automation: abort all");
      return;
    }
    if (type === "reset-work" || type === "reset_work" || type === "soft-reset") {
      this.manager.cancelAllWork(botId, "automation reset-work");
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

/**
 * String koşul eşleşmesi.
 * eq/contains/startsWith: value forde | ile VEYA listesi (mine|gather).
 * neq: listedeki hiçbirine eşit değilse true.
 * regex: value tam regex deseni (i flag).
 */
function stringMatches(
  actual: string,
  expected: string,
  mode: "eq" | "neq" | "contains" | "startsWith" | "regex" | string = "eq"
): boolean {
  const a = String(actual ?? "");
  const e = String(expected ?? "").trim();
  if (!e) return false;
  if (mode === "regex") {
    try {
      return new RegExp(e, "i").test(a);
    } catch {
      return false;
    }
  }
  const al = a.toLowerCase();
  const parts = e
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return false;
  switch (mode) {
    case "neq":
    case "not_eq":
    case "ne":
      return !parts.some((p) => al === p);
    case "contains":
      return parts.some((p) => al.includes(p));
    case "startsWith":
    case "starts_with":
      return parts.some((p) => al.startsWith(p));
    case "eq":
    case "exact":
    default:
      return parts.some((p) => al === p);
  }
}

function resolveContextExpression(value: unknown, ctx: AutomationContext): unknown {
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{([\w.-]+)\}$/);
  if (exact) return contextValue(ctx, exact[1]!) ?? "";
  return interpolateValue(value, ctx);
}

function contextValue(ctx: AutomationContext, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(ctx, path)) return ctx[path];
  const parts = path.split(".");
  let current: unknown = ctx;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function interpolateValue(value: string, ctx: AutomationContext): string {
  return value.replace(/\{([\w.-]+)\}/g, (_match, key: string) => {
    const resolved = contextValue(ctx, key);
    if (resolved == null) return "";
    if (typeof resolved === "object") return JSON.stringify(resolved);
    return String(resolved);
  });
}

function interpolate(s: string, ctx: Record<string, string>) {
  return interpolateValue(s, ctx);
}

function interpolateRecord(value: unknown, ctx: AutomationContext): unknown {
  if (Array.isArray(value)) return value.map((item) => interpolateRecord(item, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, interpolateRecord(item, ctx)])
    );
  }
  return resolveContextExpression(value, ctx);
}

function stringifyContext(ctx: AutomationContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ctx).map(([key, value]) => [
      key,
      value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)
    ])
  );
}

function compareContextValues(left: unknown, operator: string, right: unknown): boolean {
  if (operator === "exists") return left !== undefined && left !== null && left !== "";
  if (operator === "not_exists") return left === undefined || left === null || left === "";
  if (operator === "truthy") return toBoolean(left);
  if (operator === "falsy") return !toBoolean(left);

  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (["gt", "gte", "lt", "lte"].includes(operator) && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    if (operator === "gt") return leftNumber > rightNumber;
    if (operator === "gte") return leftNumber >= rightNumber;
    if (operator === "lt") return leftNumber < rightNumber;
    return leftNumber <= rightNumber;
  }

  const a = String(left ?? "");
  const b = String(right ?? "");
  if (operator === "regex") {
    try {
      return new RegExp(b, "i").test(a);
    } catch {
      return false;
    }
  }
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (operator === "neq") return al !== bl;
  if (operator === "contains") return al.includes(bl);
  if (operator === "not_contains") return !al.includes(bl);
  if (operator === "starts_with") return al.startsWith(bl);
  if (operator === "ends_with") return al.endsWith(bl);
  return al === bl;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  return !["", "0", "false", "no", "off", "null", "undefined"].includes(normalized);
}

function normalizeVariableName(value: string): string {
  return value.trim().replace(/^\{+|\}+$/g, "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeAutomationRule(rule: AutomationRule): AutomationRule {
  return {
    ...rule,
    conditions: rule.conditions ?? [],
    actions: rule.actions ?? [],
    elseActions: rule.elseActions ?? [],
    onErrorActions: rule.onErrorActions ?? [],
    flow: rule.flow ? normalizeFlow(rule.flow) : undefined,
    variables: rule.variables ?? {},
    runPolicy: {
      concurrency: rule.runPolicy?.concurrency ?? "skip",
      maxRuntimeMs: rule.runPolicy?.maxRuntimeMs ?? 600_000,
      maxSteps: rule.runPolicy?.maxSteps ?? 500
    }
  };
}

function prepareFlow(nodes: AutomationNode[]): AutomationNode[] {
  const normalized = normalizeFlow(nodes);
  validateFlow(normalized);
  return normalized;
}

function validateFlow(nodes: AutomationNode[], depth = 0, counter = { count: 0 }) {
  if (!Array.isArray(nodes)) throw new Error("Advanced flow must be a node list");
  if (depth > 24) throw new Error("Advanced flow nested condition limit exceeded (24)");
  for (const node of nodes) {
    counter.count += 1;
    if (counter.count > 2_000) throw new Error("Advanced flow node limit exceeded (2000)");
    if (!node || typeof node !== "object" || !node.id) throw new Error("Invalid automation node");
    if (node.type === "action") {
      if (!node.action || typeof node.action.type !== "string" || !node.action.type.trim()) {
        throw new Error("Action node requires an action type");
      }
      validateFlow(node.onError ?? [], depth + 1, counter);
      continue;
    }
    if (node.type === "if") {
      validateConditionGroup(node.condition, depth + 1);
      validateFlow(node.then ?? [], depth + 1, counter);
      validateFlow(node.else ?? [], depth + 1, counter);
      continue;
    }
    if (node.type === "repeat") {
      if (node.while) validateConditionGroup(node.while, depth + 1);
      validateFlow(node.body ?? [], depth + 1, counter);
      continue;
    }
    if (node.type === "wait") {
      if (node.until) validateConditionGroup(node.until, depth + 1);
      continue;
    }
    if (node.type === "set") {
      if (!normalizeVariableName(node.name)) throw new Error("Variable node requires a valid name");
      continue;
    }
    if (node.type !== "stop_flow") throw new Error(`Unknown automation node: ${String((node as { type?: unknown }).type)}`);
  }
}

function validateConditionGroup(group: AutomationConditionGroup, depth: number) {
  if (!group || group.kind !== "group" || !Array.isArray(group.items)) {
    throw new Error("Invalid condition group");
  }
  if (depth > 24) throw new Error("Condition group nesting limit exceeded (24)");
  if (!["all", "any", "not"].includes(group.operator)) throw new Error("Invalid condition group operator");
  for (const item of group.items) {
    if (item.kind === "group") validateConditionGroup(item, depth + 1);
    else if (item.kind === "bot") {
      if (!item.condition?.type) throw new Error("Bot condition type required");
    } else if (item.kind === "compare") {
      if (!item.left?.trim()) throw new Error("Left value required for comparison");
    } else {
      throw new Error("Unknown condition node");
    }
  }
}

function normalizeFlow(nodes: AutomationNode[]): AutomationNode[] {
  return nodes.map((raw) => {
    const node = { ...raw, id: raw.id || newFlowNodeId() } as AutomationNode;
    if (node.type === "if") {
      node.condition = normalizeConditionGroup(node.condition);
      node.then = normalizeFlow(node.then ?? []);
      node.else = normalizeFlow(node.else ?? []);
    } else if (node.type === "repeat") {
      node.body = normalizeFlow(node.body ?? []);
      if (node.while) node.while = normalizeConditionGroup(node.while);
    } else if (node.type === "wait" && node.until) {
      node.until = normalizeConditionGroup(node.until);
    } else if (node.type === "action") {
      node.onError = normalizeFlow(node.onError ?? []);
    }
    return node;
  });
}

function normalizeConditionGroup(group: AutomationConditionGroup | undefined): AutomationConditionGroup {
  const source = group ?? defaultConditionGroup();
  return {
    kind: "group",
    operator: source.operator ?? "all",
    items: (source.items ?? []).map((item) =>
      item.kind === "group" ? normalizeConditionGroup(item) : item
    )
  };
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
    label: "Chat / command",
    fields: ["pattern", "match", "from", "player", "commandPrefix"],
    hint: "match=command → /come Steve (arg0). startsWith, contains, exact, regex."
  },
  { type: "attacked", label: "Bot was attacked", fields: ["source", "player"], hint: "mob | player | all" },
  { type: "player_nearby", label: "Player nearby", fields: ["radius", "player", "from"] },
  {
    type: "player_far",
    label: "Player far (out of range)",
    fields: ["player", "radius"],
    hint: "Distance > radius or player not visible. empty player = follow target (@follow)"
  },
  {
    type: "follow_out_of_range",
    label: "Follow: target out of range",
    fields: ["radius"],
    hint: "While following, fires if target goes beyond followDistance+4 (or radius). THEN: unfollow / abort_all"
  },
  { type: "player_joined", label: "Player joined (tab)", fields: [] },
  { type: "player_left", label: "Player left (tab)", fields: [] },
  { type: "health_below", label: "Health below threshold", fields: ["threshold"] },
  { type: "food_below", label: "Hunger below threshold", fields: ["threshold"] },
  {
    type: "item_count",
    label: "Item count (threshold)",
    fields: ["item", "comparison", "threshold"],
    hint: "e.g. oak_log < 16 → collect"
  },
  {
    type: "item_gained",
    label: "Item gained / increased",
    fields: ["item", "threshold"],
    hint: "After collect/loot/craft count rises. empty item = any; threshold = min increase"
  },
  { type: "inventory_full", label: "Inventory full", fields: [] },
  { type: "interval", label: "Timer", fields: ["everyMs"] },
  { type: "bot_spawned", label: "Bot spawned", fields: [] },
  { type: "bot_died", label: "Bot died", fields: [] },
  {
    type: "task_done",
    label: "Task completed successfully",
    fields: ["taskType"],
    hint: "collect-wood, mine, craft, gather… empty taskType = all"
  },
  { type: "task_failed", label: "Task failed", fields: ["taskType"] }
];

export const CONDITION_META: Array<{
  type: RuleCondition["type"];
  label: string;
  fields: string[];
  hint?: string;
}> = [
  { type: "online", label: "Bot online", fields: [] },
  { type: "offline", label: "Bot offline", fields: [] },
  { type: "task_idle", label: "No task (idle)", fields: [] },
  { type: "task_busy", label: "Task running", fields: [] },
  {
    type: "task_is",
    label: "Task type equals / matches",
    fields: ["taskType", "match"],
    hint: "mine | gather | craft | none… OR with |. match: eq | neq | contains | startsWith | regex"
  },
  {
    type: "task_label_is",
    label: "Task label matches",
    fields: ["value", "match"],
    hint: "Search UI label (contains default). e.g. value=oak match=contains"
  },
  {
    type: "combat_mode_is",
    label: "Combat mode equals",
    fields: ["value", "match"],
    hint: "idle | attacking | following | defending…"
  },
  {
    type: "follow_player_is",
    label: "Follow target is",
    fields: ["player", "match"],
    hint: "player=Steve or Steve|Alex"
  },
  {
    type: "status_is",
    label: "Bot status equals",
    fields: ["value", "match"],
    hint: "online | stopped | connecting…"
  },
  { type: "following", label: "Following", fields: [] },
  { type: "not_following", label: "Not following", fields: [] },
  { type: "health_below", label: "Health ≤ threshold", fields: ["threshold"] },
  { type: "health_above", label: "Health ≥ threshold", fields: ["threshold"] },
  { type: "food_below", label: "Hunger ≤ threshold", fields: ["threshold"] },
  { type: "food_above", label: "Hunger ≥ threshold", fields: ["threshold"] },
  { type: "has_item", label: "Has item", fields: ["item"] },
  { type: "not_has_item", label: "Missing item", fields: ["item"] },
  { type: "item_count", label: "Item count", fields: ["item", "comparison", "threshold"] },
  { type: "player_near", label: "Player nearby", fields: ["player", "radius"] },
  { type: "player_far", label: "Player far", fields: ["player", "radius"] },
  { type: "in_dimension", label: "Dimension", fields: ["dimension"] },
  { type: "time_day", label: "Daytime", fields: [] },
  { type: "time_night", label: "Nighttime", fields: [] }
];

export const ACTION_META: Array<{ type: string; label: string; fields: string[]; hint?: string; category?: string }> = [
  { type: "send_chat", label: "Write to chat", fields: ["text"], category: "Chat" },
  { type: "panel_notify", label: "Panel notification", fields: ["message", "level"], category: "Chat" },
  {
    type: "report_status",
    label: "Bot status report (panel/chat)",
    fields: ["to", "message"],
    category: "Chat"
  },
  { type: "goto", label: "Go (player/waypoint/xyz)", fields: ["player", "waypoint", "x", "y", "z"], category: "Movement" },
  { type: "follow", label: "Follow", fields: ["player", "distance"], category: "Movement" },
  { type: "social-follow", label: "Follow (toggle companion)", fields: ["player", "distance"], category: "Movement" },
  { type: "unfollow", label: "Stop following", fields: ["player"], category: "Movement" },
  {
    type: "cancel_work",
    label: "Cancel any work (task+walk)",
    fields: [],
    category: "Movement"
  },
  { type: "leave_task", label: "Cancel current task only", fields: [], category: "Movement" },
  { type: "stop_tasks", label: "Clear task queue", fields: [], category: "Movement" },
  { type: "stop", label: "Stop movement/pathfinder", fields: [], category: "Movement" },
  {
    type: "abort_all",
    label: "Abort all (task+follow+path)",
    fields: [],
    category: "Movement"
  },
  { type: "reset-work", label: "Reset all work (soft-reset)", fields: [], category: "Movement" },
  { type: "wait", label: "Wait (sec)", fields: ["seconds"], category: "Movement" },
  { type: "attack", label: "Attack", fields: ["player"], category: "Combat" },
  { type: "social-attack", label: "Attack (toggle)", fields: ["player"], category: "Combat" },
  { type: "clear-mobs", label: "Clear mobs", fields: ["radius"], category: "Combat" },
  { type: "flee", label: "Flee", fields: [], category: "Combat" },
  { type: "protect", label: "Protect (escort)", fields: ["player"], category: "Combat" },
  { type: "defend_self", label: "Self-defense mode", fields: ["mode"], category: "Combat" },
  { type: "set_defend", label: "Set defense", fields: ["mode"], category: "Combat" },
  { type: "equip_best", label: "Equip best weapon", fields: [], category: "Combat" },
  { type: "loot_death", label: "Go to death loot", fields: [], category: "Combat" },
  { type: "eat", label: "Eat", fields: [], category: "Survival" },
  { type: "hunt", label: "Hunt", fields: ["radius"], category: "Survival" },
  { type: "cook", label: "Cook", fields: [], category: "Survival" },
  { type: "acquire_food", label: "Acquire food", fields: [], category: "Survival" },
  {
    type: "collect",
    label: "Smart gather (auto strategy)",
    fields: ["item", "block", "count", "countMode"],
    category: "Work"
  },
  {
    type: "collect_item",
    label: "Smart collect item",
    fields: ["item", "count", "countMode"],
    category: "Work"
  },
  { type: "mine", label: "Mine ore (underground strategy)", fields: ["ore", "count", "mode", "countMode"], category: "Work" },
  { type: "craft", label: "Craft", fields: ["item", "count"], category: "Work" },
  { type: "collect_drops", label: "Pick up ground items", fields: ["filter", "radius"], category: "Work" },
  {
    type: "drop_items",
    label: "Drop specific items",
    fields: ["item", "count", "dropMode", "match", "respectKeepItems", "failIfMissing", "requireCount"],
    hint: "count: drop N · all: drop all matches · keep: keep N, drop excess",
    category: "Work"
  },
  {
    type: "deposit",
    label: "Deposit to chest",
    fields: ["filter", "x", "y", "z"],
    hint: "x/y/z empty = nearest chest · filter: name-contains",
    category: "Work"
  },
  {
    type: "withdraw",
    label: "Withdraw from chest",
    fields: ["item", "count", "x", "y", "z"],
    hint: "x/y/z empty = nearest chest",
    category: "Work"
  },
  // ---- Faz 19 tarım (issue #5) ---------------------------------------------------------
  {
    type: "till",
    label: "Till soil (hoe → farmland)",
    fields: ["x", "y", "z", "radius"],
    hint: "x/y/z empty = around bot · radius 1-16 (default 6)",
    category: "Farm"
  },
  {
    type: "plant",
    label: "Plant crops",
    fields: ["crop", "x", "y", "z", "radius"],
    hint: "crop: wheat_seeds | carrot | potato | beetroot_seeds | melon_seeds | pumpkin_seeds",
    category: "Farm"
  },
  {
    type: "harvest",
    label: "Harvest mature crops (+replant)",
    fields: ["x", "y", "z", "radius", "replant"],
    hint: "replant=false to skip replanting",
    category: "Farm"
  },
  {
    type: "farm-cycle",
    label: "Farm loop (till→harvest→plant→deposit)",
    fields: [
      "crop",
      "x",
      "y",
      "z",
      "radius",
      "intervalSec",
      "maxCycles",
      "depositX",
      "depositY",
      "depositZ",
      "depositNearest"
    ],
    hint: "maxCycles empty = run until stopped · deposit coords = produce chest (or depositNearest=true)",
    category: "Farm"
  }
];

/** tarım aksiyon takma adları → BotInstance aksiyon tipi (rule + flow ortak) */
export const FARM_ACTION_KINDS: Record<string, string> = {
  till: "till",
  "till-soil": "till",
  till_soil: "till",
  çapala: "till",
  plant: "plant",
  "plant-crops": "plant",
  plant_crops: "plant",
  ekim: "plant",
  harvest: "harvest",
  "harvest-crops": "harvest",
  harvest_crops: "harvest",
  hasat: "harvest",
  "farm-cycle": "farm-cycle",
  farm_cycle: "farm-cycle",
  farm: "farm-cycle",
  tarla: "farm-cycle"
};

/** Aksiyon metinlerinde {var} — tetikleyiciye göre hangi veriler gelir */
export type ContextVarDoc = { name: string; desc: string };

export const CONTEXT_VARS_COMMON: ContextVarDoc[] = [
  // canlı bot durumu — her tetikleyicide
  { name: "task", desc: "Active task type or none" },
  { name: "taskType", desc: "same as task" },
  { name: "label", desc: "Active task label or —" },
  { name: "taskLabel", desc: "same as label" },
  { name: "taskState", desc: "running | idle | none…" },
  { name: "hasTask", desc: "1 = has task, 0 = none" },
  { name: "busy", desc: "1 = busy" },
  { name: "idle", desc: "1 = idle" },
  { name: "queueLength", desc: "Queued task count" },
  { name: "queueTypes", desc: "Queue types (comma-separated)" },
  { name: "bot", desc: "Bot username" },
  { name: "status", desc: "online | stopped | …" },
  { name: "health", desc: "Can" },
  { name: "food", desc: "Hunger" },
  { name: "dimension", desc: "Dimension" },
  { name: "position", desc: "x,y,z" },
  { name: "combatMode", desc: "idle | attacking | following…" },
  { name: "mode", desc: "same as combatMode" },
  { name: "activeTarget", desc: "Combat target" },
  { name: "followPlayer", desc: "Followed player" },
  { name: "followDistance", desc: "Follow distance" },
  { name: "following", desc: "1 = following" },
  { name: "protectPlayers", desc: "Protected players" },
  { name: "branch", desc: "then | else" },
  { name: "error", desc: "ON ERROR: error message" },
  { name: "failedAction", desc: "ON ERROR: failed action type" },
  { name: "runId", desc: "Advanced flow run id" },
  { name: "last.status", desc: "Son aksiyon: completed | queued | done | failed | cancelled | timeout" },
  { name: "last.taskId", desc: "Task id created by last action" },
  { name: "last.taskType", desc: "Last action task type" },
  { name: "last.label", desc: "Last action task label" },
  { name: "last.error", desc: "Last action error message" },
  { name: "loopIndex", desc: "Loop index (zero-based)" },
  { name: "loopNumber", desc: "Loop number (one-based)" },
  { name: "attempt", desc: "Action attempt number" }
];

export const CONTEXT_VARS_BY_TRIGGER: Record<string, ContextVarDoc[]> = {
  chat: [
    { name: "player", desc: "Chat author player" },
    { name: "text", desc: "Raw chat text" },
    { name: "command", desc: "Command name (match=command, e.g. come)" },
    { name: "arg", desc: "All args after command (space-separated)" },
    { name: "args", desc: "same as arg" },
    { name: "arg0", desc: "1st argument — /topla cobble 32 → cobble" },
    { name: "arg1", desc: "2nd argument — /topla cobble 32 → 32" },
    { name: "arg2", desc: "3rd argument" }
  ],
  attacked: [
    { name: "attacker", desc: "Attacker mob/player label" },
    { name: "player", desc: "same as attacker (compat)" }
  ],
  player_nearby: [
    { name: "player", desc: "Approaching player" },
    { name: "distance", desc: "Distance (blocks, integer)" }
  ],
  player_far: [
    { name: "player", desc: "Far player / follow target" },
    { name: "distance", desc: "Distance or ∞ (not visible)" },
    { name: "radius", desc: "Rule threshold" },
    { name: "followDistance", desc: "Companion follow distance" }
  ],
  follow_out_of_range: [
    { name: "player", desc: "Followed player" },
    { name: "distance", desc: "Mesafe veya ∞" },
    { name: "radius", desc: "Distance threshold" },
    { name: "followDistance", desc: "Configured follow distance" }
  ],
  player_joined: [{ name: "player", desc: "Joining player" }],
  player_left: [{ name: "player", desc: "Leaving player" }],
  health_below: [
    { name: "health", desc: "Current health" },
    { name: "food", desc: "Current hunger" }
  ],
  food_below: [
    { name: "health", desc: "Current health" },
    { name: "food", desc: "Current hunger" }
  ],
  item_count: [
    { name: "item", desc: "Watched item name" },
    { name: "count", desc: "Inventory has insufficientki adet" }
  ],
  item_gained: [
    { name: "item", desc: "Gained item" },
    { name: "gained", desc: "same as item" },
    { name: "count", desc: "New total count" },
    { name: "delta", desc: "How much increased (+N)" }
  ],
  task_done: [
    { name: "task", desc: "Task type (same as taskType)" },
    { name: "taskType", desc: "Task type: collect-wood, mine, craft…" },
    { name: "label", desc: "Task label (UI label)" },
    { name: "taskLabel", desc: "same as label" },
    { name: "status", desc: "done" },
    { name: "taskId", desc: "Completed task id" },
    { name: "taskStatus", desc: "Task status" },
    { name: "taskProgressDone", desc: "Last progress value" },
    { name: "taskProgressTotal", desc: "Total progress value" },
    { name: "taskProgressLabel", desc: "Progress label" }
  ],
  task_failed: [
    { name: "task", desc: "Task type" },
    { name: "taskType", desc: "Task type" },
    { name: "label", desc: "Task label" },
    { name: "taskLabel", desc: "same as label" },
    { name: "status", desc: "failed" },
    { name: "taskId", desc: "Failed task id" },
    { name: "taskStatus", desc: "Task status" },
    { name: "taskError", desc: "Task error message" },
    { name: "taskProgressDone", desc: "Last progress value" },
    { name: "taskProgressTotal", desc: "Total progress value" },
    { name: "taskProgressLabel", desc: "Progress label" }
  ],
  inventory_full: [],
  interval: [],
  bot_spawned: [],
  bot_died: []
};

export const CONTEXT_VARS_ALL: string[] = [
  ...new Set(
    [
      ...CONTEXT_VARS_COMMON.map((v) => v.name),
      ...Object.values(CONTEXT_VARS_BY_TRIGGER).flatMap((list) => list.map((v) => v.name))
    ].map((n) => `{${n}}`)
  )
].sort();

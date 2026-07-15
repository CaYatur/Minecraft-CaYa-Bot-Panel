import { useEffect, useMemo, useState } from "react";
import { Settings2, X } from "lucide-react";
import { ItemPicker } from "../components/ItemPicker";
import {
  AdvancedFlowBuilder,
  countFlowNodes,
  legacyRuleToFlow,
  type FlowNode
} from "../components/automation/AdvancedFlowBuilder";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  botIds: string[] | "all";
  trigger: Record<string, unknown>;
  conditions: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
  elseActions?: Array<Record<string, unknown>>;
  onErrorActions?: Array<Record<string, unknown>>;
  flow?: FlowNode[] | null;
  variables?: Record<string, string | number | boolean | null>;
  runPolicy?: { concurrency?: "skip" | "parallel"; maxRuntimeMs?: number; maxSteps?: number };
  cooldownMs: number;
  maxTriggersPerMinute: number;
}

interface MetaField {
  type: string;
  label: string;
  fields: string[];
  hint?: string;
  category?: string;
}

interface ContextVarDoc {
  name: string;
  desc: string;
}

interface Meta {
  triggers: MetaField[];
  actions: MetaField[];
  conditions?: MetaField[];
  templates?: string[];
  vars?: string[];
  varsByTrigger?: Record<string, ContextVarDoc[]>;
  varsCommon?: ContextVarDoc[];
}

const fieldCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500";

type CondRow = {
  type: string;
  item?: string;
  threshold?: number;
  player?: string;
  radius?: number;
  comparison?: string;
  dimension?: string;
  /** task_is vb. */
  taskType?: string;
  /** task_label_is / combat_mode_is / status_is */
  value?: string;
  /** eq | neq | contains | startsWith | regex */
  match?: string;
};
type ActRow = {
  type: string;
  player?: string;
  text?: string;
  message?: string;
  level?: string;
  item?: string;
  block?: string;
  ore?: string;
  count?: number | string;
  /** add = mevcut envantere ekle, target = toplam envanter hedefi */
  countMode?: "add" | "target";
  dropMode?: "count" | "all" | "keep";
  match?: "exact" | "contains";
  respectKeepItems?: boolean;
  failIfMissing?: boolean;
  requireCount?: boolean;
  radius?: number;
  distance?: number;
  mode?: string;
  filter?: string;
  seconds?: number;
  waypoint?: string;
  /** report_status: panel | chat | both */
  to?: string;
};

const emptyCond = (): CondRow => ({ type: "task_idle" });

export function Automations() {
  const bots = useAppStore((s) => s.bots);
  const servers = useAppStore((s) => s.servers);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();

  const emptyAct = (): ActRow => ({
    type: "panel_notify",
    message: t("automations.defaultNotify"),
    level: "info"
  });

  const [rules, setRules] = useState<Rule[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [showBuilder, setShowBuilder] = useState(true);
  /** null = yeni kural; string = düzenlenen kural id */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ruleEnabled, setRuleEnabled] = useState(true);

  // ── Form state ──
  const [name, setName] = useState(() => "New rule");
  const [botIds, setBotIds] = useState<string>("all");
  const [cooldownMs, setCooldownMs] = useState(3000);
  const [maxPerMin, setMaxPerMin] = useState(10);

  const [triggerType, setTriggerType] = useState("chat");
  const [pattern, setPattern] = useState("gel");
  const [match, setMatch] = useState("command");
  const [from, setFrom] = useState("authorized");
  const [player, setPlayer] = useState("");
  const [commandPrefix, setCommandPrefix] = useState("/");
  const [threshold, setThreshold] = useState(10);
  const [everyMs, setEveryMs] = useState(60_000);
  const [radius, setRadius] = useState(16);
  const [source, setSource] = useState("all");
  const [item, setItem] = useState("oak_log");
  const [comparison, setComparison] = useState("lt");
  const [taskType, setTaskType] = useState("");

  const [conditions, setConditions] = useState<CondRow[]>([]);
  const [actions, setActions] = useState<ActRow[]>([
    { type: "panel_notify", message: "rule", level: "info" }
  ]);
  /** ELSE: IF tutmazsa (tek blok) */
  const [elseActions, setElseActions] = useState<ActRow[]>([]);
  /** ON ERROR: THEN hata verirse (tek blok) */
  const [onErrorActions, setOnErrorActions] = useState<ActRow[]>([]);
  const [editorMode, setEditorMode] = useState<"simple" | "advanced">("simple");
  const [flow, setFlow] = useState<FlowNode[]>([]);
  const [variablesJson, setVariablesJson] = useState("{}");
  const [concurrency, setConcurrency] = useState<"skip" | "parallel">("skip");
  const [maxRuntimeMs, setMaxRuntimeMs] = useState(600_000);
  const [maxSteps, setMaxSteps] = useState(500);

  // dil değişince varsayılan isim/bildirim (form boşken)
  useEffect(() => {
    if (!editingId) {
      setName((n) =>
        n === "Yeni kural" || n === "New rule" || n === "rule" || !n ? t("automations.defaultName") : n
      );
      setActions((acts) =>
        acts.length === 1 && acts[0]?.type === "panel_notify" && (acts[0].message === "kural tetiklendi" || acts[0].message === "Rule triggered" || acts[0].message === "rule" || acts[0].message === "kural")
          ? [emptyAct()]
          : acts
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const botList = Object.values(bots);
  const catalogVersion = useMemo(() => {
    if (botIds !== "all" && botIds) {
      const b = bots[botIds];
      const srv = servers.find((s) => s.id === b?.config.serverId);
      return srv?.version ?? "auto";
    }
    return servers[0]?.version ?? "auto";
  }, [botIds, bots, servers]);

  const load = async () => {
    const [list, m] = await Promise.all([
      api.get<Rule[]>("/api/rules"),
      api.get<Meta>("/api/rules/meta").catch(() => null)
    ]);
    setRules(list);
    if (m) setMeta(m);
  };

  useEffect(() => {
    void load().catch(() => {});
  }, []);

  const triggers = meta?.triggers ?? [
    { type: "chat", label: "chat", fields: [] },
    { type: "item_gained", label: "item_gained", fields: [] },
    { type: "item_count", label: "item_count", fields: [] },
    { type: "attacked", label: "attacked", fields: [] }
  ];
  const actionMeta = meta?.actions ?? [{ type: "goto", label: "goto", fields: [] }];
  const conditionMeta = meta?.conditions ?? [
    { type: "task_idle", label: "task_idle", fields: [] },
    { type: "online", label: "online", fields: [] }
  ];

  /** Sunucu meta etiketini dil dosyasından çöz (yoksa fallback) */
  const metaLabel = (kind: "triggers" | "conditions" | "actions", type: string, fallback?: string) => {
    const key = `automations.${kind}.${type}`;
    const translated = t(key);
    return translated === key ? fallback || type : translated;
  };
  const metaHint = (type: string, fallback?: string) => {
    const key = `automations.triggerHints.${type}`;
    const translated = t(key);
    return translated === key ? fallback : translated;
  };
  const catLabel = (cat?: string) => {
    if (!cat) return "";
    const key = `automations.actionCategories.${cat}`;
    const translated = t(key);
    return translated === key ? cat : translated;
  };

  const varsForTrigger: ContextVarDoc[] = meta?.varsByTrigger?.[triggerType] ?? [];
  const varsCommon: ContextVarDoc[] = meta?.varsCommon ?? [
    { name: "error", desc: "ON ERROR message" },
    { name: "failedAction", desc: "failed action type" },
    { name: "branch", desc: "then | else" }
  ];

  const copyVar = (name: string) => {
    const token = `{${name}}`;
    void navigator.clipboard?.writeText(token).then(
      () => toast("info", t("automations.varsCopied", { name: token })),
      () => toast("info", token)
    );
  };

  /** Değişken açıklaması — önce i18n, yoksa sunucu desc */
  const varDesc = (name: string, fallback?: string) => {
    const key = `automations.varDesc.${name}`;
    const translated = t(key);
    return translated === key ? fallback || name : translated;
  };

  const buildPayload = (): Partial<Rule> => {
    const trigger: Record<string, unknown> = { type: triggerType };
    if (triggerType === "chat") {
      trigger.pattern = pattern;
      trigger.match = match;
      trigger.from = from === "list" && player ? [player] : from;
      if (player && from !== "list") trigger.player = player;
      if (match === "command") trigger.commandPrefix = commandPrefix || "/";
    }
    if (triggerType === "attacked") {
      trigger.source = source;
      if (player) trigger.player = player;
    }
    if (triggerType === "player_nearby") {
      trigger.radius = radius;
      if (player) trigger.player = player;
      if (from === "authorized") trigger.from = "authorized";
    }
    if (triggerType === "player_far" || triggerType === "follow_out_of_range") {
      trigger.radius = radius;
      if (player) trigger.player = player;
    }
    if (triggerType === "health_below" || triggerType === "food_below") {
      trigger.threshold = threshold;
    }
    if (triggerType === "interval") trigger.everyMs = everyMs;
    if (triggerType === "item_count") {
      trigger.item = item;
      trigger.comparison = comparison;
      trigger.threshold = threshold;
    }
    if (triggerType === "item_gained") {
      if (item) trigger.item = item;
      trigger.threshold = threshold || 1;
    }
    if (triggerType === "task_done" || triggerType === "task_failed") {
      if (taskType) trigger.taskType = taskType;
    }

    const conds = conditions.map((c) => {
      const o: Record<string, unknown> = { type: c.type };
      if (c.item) o.item = c.item;
      if (c.threshold != null) o.threshold = c.threshold;
      if (c.player) o.player = c.player;
      if (c.radius != null) o.radius = c.radius;
      if (c.comparison) o.comparison = c.comparison;
      if (c.dimension) o.dimension = c.dimension;
      if (c.taskType) o.taskType = c.taskType;
      if (c.value) o.value = c.value;
      if (c.match) o.match = c.match;
      // task_is: value alanından da taskType doldur (kullanıcı hangisini yazarsa)
      if (c.type === "task_is") {
        const v = (c.taskType || c.value || "").trim();
        if (v) {
          o.taskType = v;
          o.value = v;
        }
        if (!o.match) o.match = "eq";
      }
      if (c.type === "task_label_is" || c.type === "combat_mode_is" || c.type === "status_is") {
        const v = (c.value || c.taskType || "").trim();
        if (v) o.value = v;
        if (!o.match) o.match = c.type === "task_label_is" ? "contains" : "eq";
      }
      if (c.type === "follow_player_is") {
        const v = (c.player || c.value || "").trim();
        if (v) {
          o.player = v;
          o.value = v;
        }
        if (!o.match) o.match = "eq";
      }
      return o;
    });

    const mapActs = (list: ActRow[]) =>
      list.map((a) => {
        const o: Record<string, unknown> = { type: a.type };
        if (a.player != null && a.player !== "") o.player = a.player;
        if (a.text != null) o.text = a.text;
        if (a.message != null) o.message = a.message;
        if (a.level != null) o.level = a.level;
        if (a.item != null && a.item !== "") o.item = a.item;
        if (a.block != null && a.block !== "") o.block = a.block;
        if (a.ore != null) o.ore = a.ore;
        if (a.count != null && a.count !== "") o.count = a.count;
        if (a.countMode != null) o.countMode = a.countMode;
        if (a.radius != null) o.radius = a.radius;
        if (a.distance != null) o.distance = a.distance;
        if (a.mode != null) o.mode = a.mode;
        if (a.filter != null) o.filter = a.filter;
        if (a.seconds != null) o.seconds = a.seconds;
        if (a.waypoint != null) o.waypoint = a.waypoint;
        if (a.to != null && a.to !== "") o.to = a.to;
        return o;
      });

    const acts = mapActs(actions);
    let variables: Record<string, string | number | boolean | null> = {};
    if (editorMode === "advanced") {
      const parsed = JSON.parse(variablesJson || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error(t("automations.advanced.variablesObjectError"));
      }
      variables = parsed as Record<string, string | number | boolean | null>;
    }

    return {
      name,
      enabled: ruleEnabled,
      botIds: botIds === "all" ? "all" : [botIds],
      trigger,
      conditions: conds,
      actions: acts.length ? acts : [{ type: "panel_notify", message: t("automations.defaultNotify"), level: "info" }],
      elseActions: mapActs(elseActions),
      onErrorActions: mapActs(onErrorActions),
      flow: editorMode === "advanced" ? flow : null,
      variables: editorMode === "advanced" ? variables : {},
      runPolicy:
        editorMode === "advanced"
          ? { concurrency, maxRuntimeMs, maxSteps }
          : { concurrency: "skip", maxRuntimeMs: 600_000, maxSteps: 500 },
      cooldownMs,
      maxTriggersPerMinute: maxPerMin
    };
  };

  const resetForm = () => {
    setEditingId(null);
    setRuleEnabled(true);
    setName(t("automations.defaultName"));
    setBotIds("all");
    setCooldownMs(3000);
    setMaxPerMin(10);
    setTriggerType("chat");
    setPattern("gel");
    setMatch("command");
    setFrom("authorized");
    setPlayer("");
    setCommandPrefix("/");
    setThreshold(10);
    setEveryMs(60_000);
    setRadius(16);
    setSource("all");
    setItem("oak_log");
    setComparison("lt");
    setTaskType("");
    setConditions([]);
    setActions([emptyAct()]);
    setElseActions([]);
    setOnErrorActions([]);
    setEditorMode("simple");
    setFlow([]);
    setVariablesJson("{}");
    setConcurrency("skip");
    setMaxRuntimeMs(600_000);
    setMaxSteps(500);
  };

  const parseActs = (raw: Array<Record<string, unknown>> | undefined): ActRow[] =>
    (raw ?? []).map((a) => ({
      type: String(a.type ?? "panel_notify"),
      player: a.player != null ? String(a.player) : undefined,
      text: a.text != null ? String(a.text) : undefined,
      message: a.message != null ? String(a.message) : undefined,
      level: a.level != null ? String(a.level) : undefined,
      item: a.item != null ? String(a.item) : undefined,
      block: a.block != null ? String(a.block) : undefined,
      ore: a.ore != null ? String(a.ore) : undefined,
      count: a.count as number | string | undefined,
      countMode: a.countMode === "target" ? "target" : a.countMode === "add" ? "add" : undefined,
      radius: a.radius != null ? Number(a.radius) : undefined,
      distance: a.distance != null ? Number(a.distance) : undefined,
      mode: a.mode != null ? String(a.mode) : undefined,
      filter: a.filter != null ? String(a.filter) : undefined,
      seconds: a.seconds != null ? Number(a.seconds) : undefined,
      waypoint: a.waypoint != null ? String(a.waypoint) : undefined,
      to: a.to != null ? String(a.to) : undefined
    }));

  /** Mevcut kuralı forma yükle — düzenle */
  const loadRuleIntoForm = (r: Rule) => {
    setEditingId(r.id);
    setShowBuilder(true);
    setName(r.name || t("automations.defaultNameShort"));
    setRuleEnabled(r.enabled !== false);
    setBotIds(r.botIds === "all" || !r.botIds?.length ? "all" : Array.isArray(r.botIds) ? r.botIds[0]! : "all");
    setCooldownMs(r.cooldownMs ?? 3000);
    setMaxPerMin(r.maxTriggersPerMinute ?? 10);

    const tr = (r.trigger ?? {}) as Record<string, unknown>;
    setTriggerType(String(tr.type ?? "chat"));
    setPattern(String(tr.pattern ?? ""));
    setMatch(String(tr.match ?? "contains"));
    const fr = tr.from;
    if (Array.isArray(fr)) {
      setFrom("list");
      setPlayer(String(fr[0] ?? tr.player ?? ""));
    } else {
      setFrom(String(fr ?? "authorized"));
      setPlayer(String(tr.player ?? ""));
    }
    setCommandPrefix(String(tr.commandPrefix ?? "/"));
    setThreshold(Number(tr.threshold ?? 10));
    setEveryMs(Number(tr.everyMs ?? 60_000));
    setRadius(Number(tr.radius ?? 16));
    setSource(String(tr.source ?? "all"));
    setItem(String(tr.item ?? "oak_log"));
    setComparison(String(tr.comparison ?? "lt"));
    setTaskType(String(tr.taskType ?? ""));

    setConditions(
      (r.conditions ?? []).map((c) => ({
        type: String(c.type ?? "task_idle"),
        item: c.item != null ? String(c.item) : undefined,
        threshold: c.threshold != null ? Number(c.threshold) : undefined,
        player: c.player != null ? String(c.player) : undefined,
        radius: c.radius != null ? Number(c.radius) : undefined,
        comparison: c.comparison != null ? String(c.comparison) : undefined,
        dimension: c.dimension != null ? String(c.dimension) : undefined,
        taskType: c.taskType != null ? String(c.taskType) : undefined,
        value: c.value != null ? String(c.value) : c.taskType != null ? String(c.taskType) : undefined,
        match: c.match != null ? String(c.match) : undefined
      }))
    );

    const acts = parseActs(r.actions as Array<Record<string, unknown>>);
    setActions(acts.length ? acts : [emptyAct()]);
    setElseActions(parseActs(r.elseActions as Array<Record<string, unknown>> | undefined));
    setOnErrorActions(parseActs(r.onErrorActions as Array<Record<string, unknown>> | undefined));
    const advancedFlow = Array.isArray(r.flow) ? r.flow : [];
    setEditorMode(advancedFlow.length > 0 ? "advanced" : "simple");
    setFlow(advancedFlow);
    setVariablesJson(JSON.stringify(r.variables ?? {}, null, 2));
    setConcurrency(r.runPolicy?.concurrency ?? "skip");
    setMaxRuntimeMs(r.runPolicy?.maxRuntimeMs ?? 600_000);
    setMaxSteps(r.runPolicy?.maxSteps ?? 500);
  };

  const save = async () => {
    try {
      const payload = buildPayload();
      if (editingId) {
        await api.patch(`/api/rules/${editingId}`, payload);
        toast("success", t("automations.ruleUpdated"));
      } else {
        await api.post("/api/rules", payload);
        toast("success", t("automations.ruleCreated"));
      }
      await load();
      resetForm();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = async (r: Rule) => {
    await api.patch(`/api/rules/${r.id}`, { enabled: !r.enabled });
    await load();
  };

  const remove = async (r: Rule) => {
    if (!confirm(t("automations.deleteConfirm", { name: r.name }))) return;
    await api.del(`/api/rules/${r.id}`);
    if (editingId === r.id) resetForm();
    await load();
  };

  const test = async (r: Rule) => {
    const id = botIds === "all" ? Object.keys(bots)[0] : botIds;
    if (!id) {
      toast("error", t("automations.testNeedBot"));
      return;
    }
    try {
      await api.post(`/api/rules/${r.id}/test`, { botId: id });
      toast("info", t("automations.testDry"));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const updateCond = (i: number, patch: Partial<CondRow>) =>
    setConditions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updateAct = (i: number, patch: Partial<ActRow>) =>
    setActions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updateElse = (i: number, patch: Partial<ActRow>) =>
    setElseActions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updateOnError = (i: number, patch: Partial<ActRow>) =>
    setOnErrorActions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const enableAdvancedMode = () => {
    if (flow.length === 0) {
      setFlow(
        legacyRuleToFlow(
          conditions.map((condition) => ({ ...condition })) as Array<Record<string, unknown> & { type: string }>,
          actions.map((action) => ({ ...action })) as Array<Record<string, unknown> & { type: string }>,
          elseActions.map((action) => ({ ...action })) as Array<Record<string, unknown> & { type: string }>
        )
      );
    }
    setEditorMode("advanced");
  };

  /** Tek satır aksiyon editörü (THEN / ELSE / ON ERROR) */
  const renderActRow = (
    a: ActRow,
    i: number,
    onPatch: (i: number, p: Partial<ActRow>) => void,
    onRemove: () => void
  ) => (
    <div key={i} className="flex flex-wrap items-end gap-2 rounded border border-zinc-800/80 bg-zinc-950/40 p-2">
      <span className="self-center text-[10px] text-zinc-600">{i + 1}.</span>
      <label className="flex min-w-[11rem] flex-col gap-0.5 text-xs">
        <span className="text-zinc-500">{t("automations.actionLabel")}</span>
        <select
          value={a.type}
          onChange={(e) => {
            const nextType = e.target.value;
            onPatch(i, {
              type: nextType,
              countMode: ["collect", "collect_item", "mine"].includes(nextType) ? "add" : a.countMode,
              dropMode: nextType === "drop_items" ? "count" : a.dropMode,
              match: nextType === "drop_items" ? "exact" : a.match,
              respectKeepItems: nextType === "drop_items" ? true : a.respectKeepItems,
              failIfMissing: nextType === "drop_items" ? false : a.failIfMissing,
              requireCount: nextType === "drop_items" ? false : a.requireCount
            });
          }}
          className={fieldCls}
        >
          {actionMeta.map((m) => (
            <option key={m.type} value={m.type}>
              {m.category ? `${catLabel(m.category)}: ` : ""}
              {metaLabel("actions", m.type, m.label)}
            </option>
          ))}
        </select>
      </label>
      {["goto", "follow", "attack", "protect", "social-follow", "social-attack", "unfollow"].includes(a.type) && (
        <input
          value={a.player ?? (a.type === "unfollow" ? "" : "{player}")}
          onChange={(e) => onPatch(i, { player: e.target.value })}
          placeholder={a.type === "unfollow" ? t("automations.phUnfollow") : t("automations.phPlayerArg")}
          className={`${fieldCls} w-36`}
        />
      )}
      {a.type === "send_chat" && (
        <input
          value={a.text ?? ""}
          onChange={(e) => onPatch(i, { text: e.target.value })}
          placeholder={t("automations.phMessageError")}
          className={`${fieldCls} min-w-[12rem] flex-1`}
        />
      )}
      {a.type === "panel_notify" && (
        <input
          value={a.message ?? ""}
          onChange={(e) => onPatch(i, { message: e.target.value })}
          placeholder={t("automations.phNotifyError")}
          className={`${fieldCls} min-w-[12rem] flex-1`}
        />
      )}
      {(a.type === "report_status" || a.type === "bot_status" || a.type === "durum-raporu") && (
        <>
          <input
            value={a.message ?? ""}
            onChange={(e) => onPatch(i, { message: e.target.value })}
            placeholder={t("automations.phReportStatus")}
            className={`${fieldCls} min-w-[14rem] flex-1`}
          />
          <select
            value={a.to ?? "panel"}
            onChange={(e) => onPatch(i, { to: e.target.value })}
            className={`${fieldCls} w-28`}
            title={t("automations.reportStatusTo")}
          >
            <option value="panel">{t("automations.reportToPanel")}</option>
            <option value="chat">{t("automations.reportToChat")}</option>
            <option value="both">{t("automations.reportToBoth")}</option>
          </select>
        </>
      )}
      {["collect", "collect_item", "craft", "withdraw", "mine"].includes(a.type) && (
        <>
          {a.type === "mine" ? (
            <ItemPicker
              version={catalogVersion}
              kind="ores"
              value={String(a.ore ?? "iron")}
              onChange={(n) => onPatch(i, { ore: n.replace(/_ore$/, "") })}
            />
          ) : (
            <ItemPicker
              version={catalogVersion}
              kind="items"
              value={String(a.item ?? a.block ?? "oak_log")}
              onChange={(n) => onPatch(i, { item: n, block: n })}
            />
          )}
          <input
            value={a.count ?? 16}
            onChange={(e) => onPatch(i, { count: e.target.value })}
            placeholder={t("automations.phCount")}
            className={`${fieldCls} w-24`}
          />
          {["collect", "collect_item", "mine"].includes(a.type) && (
            <label className="flex min-w-[11rem] flex-col gap-0.5 text-xs">
              <span className="text-zinc-500">{t("automations.countModeLabel")}</span>
              <select
                value={a.countMode ?? "add"}
                onChange={(e) => onPatch(i, { countMode: e.target.value as "add" | "target" })}
                className={fieldCls}
              >
                <option value="add">{t("automations.countModeAdd")}</option>
                <option value="target">{t("automations.countModeTarget")}</option>
              </select>
            </label>
          )}
        </>
      )}
      {["clear-mobs", "hunt", "collect_drops"].includes(a.type) && (
        <input
          type="number"
          value={a.radius ?? 16}
          onChange={(e) => onPatch(i, { radius: Number(e.target.value) })}
          className={`${fieldCls} w-20`}
        />
      )}
      {a.type === "wait" && (
        <input
          type="number"
          value={a.seconds ?? 1}
          onChange={(e) => onPatch(i, { seconds: Number(e.target.value) })}
          className={`${fieldCls} w-20`}
        />
      )}
      {a.type === "drop_items" && (
        <>
          <ItemPicker
            version={catalogVersion}
            kind="items"
            value={String(a.item ?? "cobblestone")}
            onChange={(n) => onPatch(i, { item: n })}
          />
          <label className="flex min-w-[9rem] flex-col gap-0.5 text-xs">
            <span className="text-zinc-500">{t("automations.dropModeLabel")}</span>
            <select
              value={a.dropMode ?? "count"}
              onChange={(e) => onPatch(i, { dropMode: e.target.value as "count" | "all" | "keep" })}
              className={fieldCls}
            >
              <option value="count">{t("automations.dropModeCount")}</option>
              <option value="all">{t("automations.dropModeAll")}</option>
              <option value="keep">{t("automations.dropModeKeep")}</option>
            </select>
          </label>
          {(a.dropMode ?? "count") !== "all" && (
            <input
              min={0}
              type="number"
              value={a.count ?? 1}
              onChange={(e) => onPatch(i, { count: e.target.value })}
              placeholder={t("automations.phCountArg")}
              className={`${fieldCls} w-24`}
            />
          )}
          <label className="flex min-w-[9rem] flex-col gap-0.5 text-xs">
            <span className="text-zinc-500">{t("automations.dropMatchLabel")}</span>
            <select
              value={a.match ?? "exact"}
              onChange={(e) => onPatch(i, { match: e.target.value as "exact" | "contains" })}
              className={fieldCls}
            >
              <option value="exact">{t("automations.dropMatchExact")}</option>
              <option value="contains">{t("automations.dropMatchContains")}</option>
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-2 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={a.respectKeepItems !== false}
              onChange={(e) => onPatch(i, { respectKeepItems: e.target.checked })}
            />
            {t("automations.dropRespectKeep")}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-2 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={a.failIfMissing === true}
              onChange={(e) => onPatch(i, { failIfMissing: e.target.checked })}
            />
            {t("automations.dropFailIfMissing")}
          </label>
          {(a.dropMode ?? "count") === "count" && (
            <label className="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-2 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={a.requireCount === true}
                onChange={(e) => onPatch(i, { requireCount: e.target.checked })}
              />
              {t("automations.dropRequireCount")}
            </label>
          )}
        </>
      )}
      <button type="button" onClick={onRemove} className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const summaryTrigger = () => {
    if (triggerType === "chat") {
      if (match === "command") return `${commandPrefix || "/"}${pattern}`;
      return `"${pattern}" (${match})`;
    }
    if (triggerType === "item_gained")
      return `+${item || t("automations.summaryAny")} (≥${threshold || 1})`;
    if (triggerType === "item_count") return `${item} ${comparison} ${threshold}`;
    if (triggerType === "attacked") return t("automations.summaryAttacked", { source });
    if (triggerType === "player_far") return `${player || "@follow"} > ${radius}m`;
    if (triggerType === "follow_out_of_range")
      return t("automations.summaryFollowOut", { radius });
    return triggerType;
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">{t("automations.title")}</h1>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
          {t("automations.rulesCount", { n: rules.length })}
        </span>
        <button
          onClick={() => void load()}
          className="ml-auto rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          {t("common.refresh")}
        </button>
        <button
          onClick={() => {
            resetForm();
            setShowBuilder(true);
          }}
          className="rounded-lg bg-indigo-600/80 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
        >
          {t("automations.newRule")}
        </button>
        <button
          onClick={() => setShowBuilder((v) => !v)}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          {showBuilder ? t("automations.hideForm") : t("automations.showForm")}
        </button>
      </div>

      {/* ── WHEN → IF → THEN builder (oluştur / düzenle) ── */}
      {showBuilder && (
        <section
          className={`space-y-3 rounded-xl border p-4 ${
            editingId
              ? "border-amber-800/50 bg-amber-950/10"
              : "border-zinc-800 bg-zinc-900/50"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">
              {editingId ? t("automations.editRule") : t("automations.createRule")}
            </div>
            {editingId && (
              <span className="mono rounded bg-amber-950/50 px-2 py-0.5 text-[10px] text-amber-300/90">
                {t("automations.editingId", { id: editingId.slice(0, 8) })}
              </span>
            )}
            <label
              className={`ml-auto flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1 select-none ${
                ruleEnabled
                  ? "border-emerald-800/50 bg-emerald-950/30 text-emerald-200"
                  : "border-zinc-700 bg-zinc-900 text-zinc-500"
              }`}
            >
              <input
                type="checkbox"
                checked={ruleEnabled}
                onChange={(e) => setRuleEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-600 text-emerald-500 focus:ring-emerald-600"
              />
              <span className="text-xs font-medium">
                {ruleEnabled ? t("automations.enabledActive") : t("automations.disabled")}
              </span>
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
              <span className="text-zinc-400">{t("automations.ruleName")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-400">{t("automations.bot")}</span>
              <select value={botIds} onChange={(e) => setBotIds(e.target.value)} className={fieldCls}>
                <option value="all">{t("automations.botAll")}</option>
                {botList.map((b) => (
                  <option key={b.config.id} value={b.config.id}>
                    {b.config.username}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex w-28 flex-col gap-1 text-sm">
              <span className="text-zinc-400">{t("automations.cooldownMs")}</span>
              <input
                type="number"
                value={cooldownMs}
                onChange={(e) => setCooldownMs(Number(e.target.value) || 0)}
                className={fieldCls}
              />
            </label>
            <label className="flex w-28 flex-col gap-1 text-sm">
              <span className="text-zinc-400">{t("automations.maxPerMin")}</span>
              <input
                type="number"
                value={maxPerMin}
                onChange={(e) => setMaxPerMin(Number(e.target.value) || 1)}
                className={fieldCls}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
            <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
              {t("automations.advanced.editorMode")}
            </span>
            <button
              type="button"
              onClick={() => setEditorMode("simple")}
              className={`rounded px-2.5 py-1 text-xs ${
                editorMode === "simple" ? "bg-zinc-200 text-zinc-950" : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {t("automations.advanced.simpleMode")}
            </button>
            <button
              type="button"
              onClick={enableAdvancedMode}
              className={`rounded px-2.5 py-1 text-xs ${
                editorMode === "advanced" ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {t("automations.advanced.advancedMode")}
            </button>
            <span className="text-[10px] text-zinc-600">{t("automations.advanced.modeHint")}</span>
          </div>

          {editorMode === "advanced" && (
            <div className="grid gap-2 rounded-lg border border-indigo-900/40 bg-indigo-950/10 p-3 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                {t("automations.advanced.concurrency")}
                <select value={concurrency} onChange={(e) => setConcurrency(e.target.value as "skip" | "parallel")} className={fieldCls}>
                  <option value="skip">{t("automations.advanced.concurrencySkip")}</option>
                  <option value="parallel">{t("automations.advanced.concurrencyParallel")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                {t("automations.advanced.maxRuntimeMs")}
                <input type="number" value={maxRuntimeMs} onChange={(e) => setMaxRuntimeMs(Number(e.target.value))} className={fieldCls} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                {t("automations.advanced.maxSteps")}
                <input type="number" value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} className={fieldCls} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-500 md:col-span-3">
                {t("automations.advanced.initialVariables")}
                <textarea
                  value={variablesJson}
                  onChange={(e) => setVariablesJson(e.target.value)}
                  className={`${fieldCls} mono min-h-20`}
                  placeholder={'{"targetCount": 16, "ore": "iron"}'}
                />
              </label>
            </div>
          )}

          {/* Pipeline visual */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-3 py-2 text-xs">
            <span className="rounded bg-amber-950/50 px-2 py-1 font-semibold text-amber-300">
              {t("automations.pipelineWhen")}
            </span>
            <span className="mono text-zinc-300">{summaryTrigger()}</span>
            {editorMode === "advanced" ? (
              <>
                <span className="text-zinc-600">→</span>
                <span className="rounded bg-indigo-950/60 px-2 py-1 font-semibold text-indigo-300">
                  {t("automations.advanced.advancedMode")}
                </span>
                <span className="text-zinc-400">
                  {t("automations.advanced.nodeCount", { n: countFlowNodes(flow) })}
                </span>
              </>
            ) : (
              <>
                <span className="text-zinc-600">→</span>
                <span className="rounded bg-sky-950/50 px-2 py-1 font-semibold text-sky-300">
                  {t("automations.pipelineIf")}
                </span>
                <span className="text-zinc-400">
                  {conditions.length
                    ? conditions.map((c) => metaLabel("conditions", c.type, c.type)).join(" · ")
                    : "—"}
                </span>
                <span className="text-zinc-600">→</span>
                <span className="rounded bg-emerald-950/50 px-2 py-1 font-semibold text-emerald-300">
                  {t("automations.pipelineThen")}
                </span>
                <span className="text-zinc-400">
                  {actions.map((a) => metaLabel("actions", a.type, a.type)).join(" · ")}
                </span>
                {elseActions.length > 0 && (
                  <>
                    <span className="text-zinc-600">/</span>
                    <span className="rounded bg-violet-950/50 px-2 py-1 font-semibold text-violet-300">
                      {t("automations.pipelineElse")}
                    </span>
                    <span className="text-zinc-400">
                      {elseActions.map((a) => metaLabel("actions", a.type, a.type)).join(" · ")}
                    </span>
                  </>
                )}
              </>
            )}
            {onErrorActions.length > 0 && (
              <>
                <span className="text-zinc-600">·</span>
                <span className="rounded bg-red-950/50 px-2 py-1 font-semibold text-red-300">
                  {t("automations.pipelineOnErr")}
                </span>
                <span className="text-zinc-400">
                  {onErrorActions.map((a) => metaLabel("actions", a.type, a.type)).join(" · ")}
                </span>
              </>
            )}
          </div>

          {/* WHEN */}
          <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 p-3">
            <div className="mb-2 text-[10px] font-semibold tracking-wide text-amber-400/90 uppercase">
              1 · {t("automations.when")}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">{t("automations.triggerType")}</span>
                <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)} className={fieldCls}>
                  {triggers.map((tr) => (
                    <option key={tr.type} value={tr.type} title={metaHint(tr.type, tr.hint)}>
                      {metaLabel("triggers", tr.type, tr.label)}
                    </option>
                  ))}
                </select>
              </label>

              {triggerType === "chat" && (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">{t("automations.pattern")}</span>
                    <input
                      value={pattern}
                      onChange={(e) => setPattern(e.target.value)}
                      placeholder={t("automations.phPattern")}
                      className={fieldCls}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">{t("automations.match")}</span>
                    <select value={match} onChange={(e) => setMatch(e.target.value)} className={fieldCls}>
                      <option value="command">{t("automations.matchCommand")}</option>
                      <option value="startsWith">{t("automations.matchStartsWith")}</option>
                      <option value="contains">{t("automations.matchContains")}</option>
                      <option value="exact">{t("automations.matchExact")}</option>
                      <option value="regex">{t("automations.matchRegex")}</option>
                    </select>
                  </label>
                  {match === "command" && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-400">{t("automations.commandPrefix")}</span>
                      <input
                        value={commandPrefix}
                        onChange={(e) => setCommandPrefix(e.target.value)}
                        placeholder="/"
                        className={fieldCls}
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">{t("automations.from")}</span>
                    <select value={from} onChange={(e) => setFrom(e.target.value)} className={fieldCls}>
                      <option value="authorized">{t("automations.fromAuthorized")}</option>
                      <option value="anyone">{t("automations.fromAnyone")}</option>
                      <option value="list">{t("automations.fromList")}</option>
                    </select>
                  </label>
                </>
              )}

              {(triggerType === "chat" ||
                triggerType === "attacked" ||
                triggerType === "player_nearby" ||
                triggerType === "player_far" ||
                from === "list") && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">
                    {triggerType === "player_far"
                      ? t("automations.playerFarHint")
                      : t("automations.specificPlayer")}
                  </span>
                  <input
                    value={player}
                    onChange={(e) => setPlayer(e.target.value)}
                    placeholder={
                      triggerType === "player_far"
                        ? t("automations.playerFarPlaceholder")
                        : t("automations.phOptionalName")
                    }
                    className={fieldCls}
                  />
                </label>
              )}

              {triggerType === "attacked" && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">{t("automations.source")}</span>
                  <select value={source} onChange={(e) => setSource(e.target.value)} className={fieldCls}>
                    <option value="all">{t("automations.sourceAll")}</option>
                    <option value="player">{t("automations.sourcePlayer")}</option>
                    <option value="mob">{t("automations.sourceMob")}</option>
                  </select>
                </label>
              )}

              {(triggerType === "item_count" || triggerType === "item_gained") && (
                <>
                  <div className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">
                      {triggerType === "item_gained" ? t("automations.itemAny") : t("automations.item")}
                    </span>
                    <ItemPicker version={catalogVersion} kind="items" value={item} onChange={setItem} />
                  </div>
                  {triggerType === "item_count" && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-400">{t("automations.comparison")}</span>
                      <select value={comparison} onChange={(e) => setComparison(e.target.value)} className={fieldCls}>
                        <option value="lt">&lt;</option>
                        <option value="lte">≤</option>
                        <option value="gt">&gt;</option>
                        <option value="gte">≥</option>
                        <option value="eq">=</option>
                      </select>
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">
                      {triggerType === "item_gained" ? t("automations.minGain") : t("automations.threshold")}
                    </span>
                    <input
                      type="number"
                      value={threshold}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                      className={fieldCls}
                    />
                  </label>
                </>
              )}

              {(triggerType === "health_below" || triggerType === "food_below") && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">{t("automations.threshold")}</span>
                  <input
                    type="number"
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className={fieldCls}
                  />
                </label>
              )}

              {triggerType === "interval" && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">{t("automations.everyMs")}</span>
                  <input
                    type="number"
                    value={everyMs}
                    onChange={(e) => setEveryMs(Number(e.target.value))}
                    className={fieldCls}
                  />
                </label>
              )}

              {(triggerType === "player_nearby" ||
                triggerType === "player_far" ||
                triggerType === "follow_out_of_range") && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">
                    {triggerType === "player_far" || triggerType === "follow_out_of_range"
                      ? t("automations.farDistance")
                      : t("automations.radius")}
                  </span>
                  <input
                    type="number"
                    value={radius}
                    onChange={(e) => setRadius(Number(e.target.value))}
                    className={fieldCls}
                  />
                </label>
              )}
              {triggerType === "follow_out_of_range" && (
                <p className="sm:col-span-2 text-[10px] text-zinc-500">{t("automations.followOutHint")}</p>
              )}

              {(triggerType === "task_done" || triggerType === "task_failed") && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">{t("automations.taskType")}</span>
                  <input
                    value={taskType}
                    onChange={(e) => setTaskType(e.target.value)}
                    placeholder={t("automations.phTaskType")}
                    className={fieldCls}
                  />
                </label>
              )}
            </div>
            {match === "command" && triggerType === "chat" && (
              <p className="mt-2 text-[10px] text-amber-600/90">{t("automations.varsExample")}</p>
            )}

            {/* Context değişkenleri — bu tetik + sonraki aksiyon (i18n) */}
            <div className="mt-3 rounded-lg border border-zinc-700/80 bg-zinc-950/50 p-2.5">
              <div className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">
                {t("automations.varsTitle")}
              </div>
              <p className="mb-1 text-[10px] leading-relaxed text-zinc-500">{t("automations.varsHow")}</p>
              <p className="mb-2 text-[10px] leading-relaxed text-zinc-500">{t("automations.howToUseVars")}</p>
              <div className="mb-2 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
                <div className="mb-1 text-[10px] font-medium text-zinc-400">{t("automations.chainExamplesTitle")}</div>
                <ul className="space-y-0.5 text-[10px] text-zinc-500">
                  <li>· {t("automations.chainEx1")}</li>
                  <li>· {t("automations.chainEx2")}</li>
                  <li>· {t("automations.chainEx3")}</li>
                  <li>· {t("automations.chainEx4")}</li>
                  <li>· {t("automations.chainEx5")}</li>
                  <li>· {t("automations.chainEx6")}</li>
                </ul>
                <div className="mt-1.5 border-t border-zinc-800 pt-1.5 text-[10px] text-indigo-300/80">
                  <div className="font-medium text-indigo-300/90">{t("automations.statusRecipeTitle")}</div>
                  <div className="text-zinc-500">{t("automations.statusRecipe")}</div>
                  <div className="mt-1 font-medium text-indigo-300/90">{t("automations.taskEqualsRecipeTitle")}</div>
                  <div className="text-zinc-500">{t("automations.taskEqualsRecipe")}</div>
                </div>
              </div>
              <div className="mb-1 text-[10px] text-amber-500/90">{t("automations.varsForTrigger")}</div>
              {varsForTrigger.length === 0 ? (
                <p className="mb-2 text-[10px] text-zinc-600 italic">{t("automations.varsNone")}</p>
              ) : (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {varsForTrigger.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      title={`${varDesc(v.name, v.desc)} · ${t("automations.varsClick")}`}
                      onClick={() => copyVar(v.name)}
                      className="max-w-[14rem] rounded border border-amber-900/40 bg-amber-950/30 px-2 py-1 text-left hover:border-amber-600/50"
                    >
                      <span className="mono text-[11px] font-medium text-amber-200">{`{${v.name}}`}</span>
                      <span className="mt-0.5 block text-[9px] leading-tight text-zinc-500">
                        {varDesc(v.name, v.desc)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="mb-1 text-[10px] text-zinc-500">{t("automations.varsAlways")}</div>
              <div className="flex flex-wrap gap-1.5">
                {varsCommon.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    title={`${varDesc(v.name, v.desc)} · ${t("automations.varsClick")}`}
                    onClick={() => copyVar(v.name)}
                    className="max-w-[14rem] rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-left hover:border-zinc-500"
                  >
                    <span className="mono text-[11px] font-medium text-zinc-300">{`{${v.name}}`}</span>
                    <span className="mt-0.5 block text-[9px] leading-tight text-zinc-600">
                      {varDesc(v.name, v.desc)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {editorMode === "simple" ? (
            <>
          {/* IF */}
          <div className="rounded-lg border border-sky-900/40 bg-sky-950/10 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold tracking-wide text-sky-400/90 uppercase">
                2 · {t("automations.if")}
              </div>
              <button
                type="button"
                onClick={() => setConditions((c) => [...c, emptyCond()])}
                className="ml-auto rounded bg-sky-900/40 px-2 py-0.5 text-[10px] text-sky-200 hover:bg-sky-900/60"
              >
                {t("automations.addCondition")}
              </button>
            </div>
            {conditions.length === 0 && (
              <p className="text-[11px] text-zinc-600 italic">{t("automations.noCondition")}</p>
            )}
            <div className="space-y-2">
              {conditions.map((c, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2 rounded border border-zinc-800/80 bg-zinc-950/40 p-2">
                  <label className="flex min-w-[10rem] flex-col gap-0.5 text-xs">
                    <span className="text-zinc-500">{t("automations.typeLabel")}</span>
                    <select
                      value={c.type}
                      onChange={(e) => updateCond(i, { type: e.target.value })}
                      className={fieldCls}
                    >
                      {conditionMeta.map((m) => (
                        <option key={m.type} value={m.type}>
                          {metaLabel("conditions", m.type, m.label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(c.type === "has_item" ||
                    c.type === "not_has_item" ||
                    c.type === "item_count") && (
                    <div className="min-w-[10rem] flex-1">
                      <ItemPicker
                        version={catalogVersion}
                        kind="items"
                        value={c.item ?? "stick"}
                        onChange={(n) => updateCond(i, { item: n })}
                      />
                    </div>
                  )}
                  {c.type === "item_count" && (
                    <label className="flex w-24 flex-col gap-0.5 text-xs">
                      <span className="text-zinc-500">{t("automations.comparison")}</span>
                      <select
                        value={c.comparison ?? "gte"}
                        onChange={(e) => updateCond(i, { comparison: e.target.value })}
                        className={fieldCls}
                      >
                        <option value="lt">&lt;</option>
                        <option value="lte">≤</option>
                        <option value="eq">=</option>
                        <option value="gte">≥</option>
                        <option value="gt">&gt;</option>
                      </select>
                    </label>
                  )}
                  {(c.type === "health_below" ||
                    c.type === "health_above" ||
                    c.type === "food_below" ||
                    c.type === "food_above" ||
                    c.type === "item_count") && (
                    <label className="flex w-20 flex-col gap-0.5 text-xs">
                      <span className="text-zinc-500">{t("automations.threshold")}</span>
                      <input
                        type="number"
                        value={c.threshold ?? 10}
                        onChange={(e) => updateCond(i, { threshold: Number(e.target.value) })}
                        className={fieldCls}
                      />
                    </label>
                  )}
                  {(c.type === "player_near" || c.type === "player_far") && (
                    <>
                      <input
                        value={c.player ?? ""}
                        onChange={(e) => updateCond(i, { player: e.target.value })}
                        placeholder={t("automations.phPlayerNear")}
                        className={`${fieldCls} w-32`}
                      />
                      <input
                        type="number"
                        value={c.radius ?? 16}
                        onChange={(e) => updateCond(i, { radius: Number(e.target.value) })}
                        className={`${fieldCls} w-20`}
                        title={t("automations.radius")}
                      />
                    </>
                  )}
                  {c.type === "in_dimension" && (
                    <input
                      value={c.dimension ?? "overworld"}
                      onChange={(e) => updateCond(i, { dimension: e.target.value })}
                      className={`${fieldCls} w-32`}
                    />
                  )}
                  {/* Görev tipi / etiket / mod / status string eşleşmeleri */}
                  {(c.type === "task_is" ||
                    c.type === "task_label_is" ||
                    c.type === "combat_mode_is" ||
                    c.type === "status_is" ||
                    c.type === "follow_player_is") && (
                    <>
                      <label className="flex min-w-[9rem] flex-1 flex-col gap-0.5 text-xs">
                        <span className="text-zinc-500">
                          {c.type === "task_is"
                            ? t("automations.condTaskType")
                            : c.type === "task_label_is"
                              ? t("automations.condTaskLabel")
                              : c.type === "combat_mode_is"
                                ? t("automations.condCombatMode")
                                : c.type === "status_is"
                                  ? t("automations.condBotStatus")
                                  : t("automations.condFollowPlayer")}
                        </span>
                        <input
                          value={
                            c.type === "task_is"
                              ? (c.taskType ?? c.value ?? "")
                              : c.type === "follow_player_is"
                                ? (c.player ?? c.value ?? "")
                                : (c.value ?? c.taskType ?? "")
                          }
                          onChange={(e) => {
                            const v = e.target.value;
                            if (c.type === "task_is") updateCond(i, { taskType: v, value: v });
                            else if (c.type === "follow_player_is") updateCond(i, { player: v, value: v });
                            else updateCond(i, { value: v });
                          }}
                          placeholder={
                            c.type === "task_is"
                              ? t("automations.phCondTaskType")
                              : c.type === "task_label_is"
                                ? t("automations.phCondTaskLabel")
                                : c.type === "combat_mode_is"
                                  ? t("automations.phCondCombatMode")
                                  : c.type === "status_is"
                                    ? t("automations.phCondBotStatus")
                                    : t("automations.phCondFollowPlayer")
                          }
                          className={fieldCls}
                        />
                      </label>
                      <label className="flex w-28 flex-col gap-0.5 text-xs">
                        <span className="text-zinc-500">{t("automations.stringMatch")}</span>
                        <select
                          value={
                            c.match ??
                            (c.type === "task_label_is" ? "contains" : "eq")
                          }
                          onChange={(e) => updateCond(i, { match: e.target.value })}
                          className={fieldCls}
                        >
                          <option value="eq">{t("automations.matchEq")}</option>
                          <option value="neq">{t("automations.matchNeq")}</option>
                          <option value="contains">{t("automations.matchContainsCond")}</option>
                          <option value="startsWith">{t("automations.matchStartsWithCond")}</option>
                          <option value="regex">{t("automations.matchRegexCond")}</option>
                        </select>
                      </label>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setConditions((rows) => rows.filter((_, j) => j !== i))}
                    className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* THEN */}
          <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold tracking-wide text-emerald-400/90 uppercase">
                3 · {t("automations.then")}
              </div>
              <button
                type="button"
                onClick={() => setActions((a) => [...a, emptyAct()])}
                className="ml-auto rounded bg-emerald-900/40 px-2 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-900/60"
              >
                {t("automations.addAction")}
              </button>
            </div>
            <div className="space-y-2">
              {actions.map((a, i) =>
                renderActRow(a, i, updateAct, () => setActions((rows) => rows.filter((_, j) => j !== i)))
              )}
            </div>
          </div>

          {/* ELSE — tek dal */}
          <div className="rounded-lg border border-violet-900/40 bg-violet-950/10 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold tracking-wide text-violet-300/90 uppercase">
                4 · {t("automations.else")}
              </div>
              {elseActions.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setElseActions([emptyAct()])}
                  className="ml-auto rounded bg-violet-900/40 px-2 py-0.5 text-[10px] text-violet-200 hover:bg-violet-900/60"
                >
                  {t("automations.addElse")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setElseActions([])}
                  className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
                >
                  {t("automations.removeElse")}
                </button>
              )}
            </div>
            {elseActions.length === 0 ? (
              <p className="text-[11px] text-zinc-600 italic">{t("automations.noElse")}</p>
            ) : (
              <div className="space-y-2">
                {elseActions.map((a, i) =>
                  renderActRow(a, i, updateElse, () => setElseActions((rows) => rows.filter((_, j) => j !== i)))
                )}
                {elseActions.length < 3 && (
                  <button
                    type="button"
                    onClick={() => setElseActions((a) => [...a, emptyAct()])}
                    className="text-[10px] text-violet-400 hover:underline"
                  >
                    {t("automations.addElseAction")}
                  </button>
                )}
              </div>
            )}
          </div>

            </>
          ) : (
            <AdvancedFlowBuilder
              value={flow}
              onChange={setFlow}
              actionMeta={actionMeta}
              conditionMeta={conditionMeta}
              catalogVersion={catalogVersion}
              t={t}
              metaLabel={(kind, type, fallback) => metaLabel(kind, type, fallback)}
              catLabel={catLabel}
            />
          )}

          {/* ON ERROR — tek blok */}
          <div className="rounded-lg border border-red-900/40 bg-red-950/10 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold tracking-wide text-red-300/90 uppercase">
                5 · {t("automations.onError")}
              </div>
              {onErrorActions.length === 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    setOnErrorActions([
                      {
                        type: "panel_notify",
                        message: t("automations.errorNotify"),
                        level: "error"
                      }
                    ])
                  }
                  className="ml-auto rounded bg-red-900/40 px-2 py-0.5 text-[10px] text-red-200 hover:bg-red-900/60"
                >
                  {t("automations.addOnError")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setOnErrorActions([])}
                  className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
                >
                  {t("automations.removeOnError")}
                </button>
              )}
            </div>
            {onErrorActions.length === 0 ? (
              <p className="text-[11px] text-zinc-600 italic">{t("automations.noOnError")}</p>
            ) : (
              <div className="space-y-2">
                <p className="text-[10px] text-red-400/80">{t("automations.onErrorHint")}</p>
                {onErrorActions.map((a, i) =>
                  renderActRow(a, i, updateOnError, () =>
                    setOnErrorActions((rows) => rows.filter((_, j) => j !== i))
                  )
                )}
                {onErrorActions.length < 3 && (
                  <button
                    type="button"
                    onClick={() => setOnErrorActions((a) => [...a, emptyAct()])}
                    className="text-[10px] text-red-400 hover:underline"
                  >
                    {t("automations.addErrorAction")}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              {editingId ? t("automations.saveChanges") : t("automations.createRule")}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => resetForm()}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
              >
                {t("automations.cancelEdit")}
              </button>
            )}
            {!editingId && (
              <button
                type="button"
                onClick={() => resetForm()}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-700"
              >
                {t("automations.clearForm")}
              </button>
            )}
            <p className="text-[10px] text-zinc-600">
              {t("automations.variables")}:{" "}
              {(
                meta?.vars ?? [
                  "{player}",
                  "{task}",
                  "{taskType}",
                  "{label}",
                  "{arg0}",
                  "{arg1}",
                  "{item}",
                  "{delta}",
                  "{error}"
                ]
              ).join(" ")}
            </p>
          </div>
        </section>
      )}

      {/* ── Mevcut kurallar (düzenle / sil) ── */}
      <div className="space-y-2">
        <div className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          {t("automations.savedRules")}
        </div>
        {rules.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 py-12 text-zinc-500">
            <Settings2 className="h-8 w-8" />
            <p className="text-sm">{t("automations.empty")}</p>
          </div>
        )}
        {rules.map((r) => (
          <div
            key={r.id}
            className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${
              editingId === r.id
                ? "border-amber-700/50 bg-amber-950/20"
                : "border-zinc-800 bg-zinc-900/50"
            }`}
          >
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 select-none ${
                r.enabled
                  ? "border-emerald-800/50 bg-emerald-950/30"
                  : "border-zinc-700 bg-zinc-900/60"
              }`}
              title={r.enabled ? t("automations.toggleOn") : t("automations.toggleOff")}
            >
              <input
                type="checkbox"
                checked={Boolean(r.enabled)}
                onChange={() => void toggle(r)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-emerald-500 focus:ring-emerald-600"
              />
              <span
                className={`text-xs font-medium ${
                  r.enabled ? "text-emerald-300" : "text-zinc-500"
                }`}
              >
                {r.enabled ? t("automations.enabled") : t("automations.disabled")}
              </span>
            </label>
            <div className="min-w-0 flex-1">
              <div className={`font-medium ${r.enabled ? "text-zinc-200" : "text-zinc-500"}`}>
                {r.name}
              </div>
              <div className="mono mt-0.5 truncate text-[11px] text-zinc-500">
                {t("automations.pipelineWhen")}{" "}
                {metaLabel(
                  "triggers",
                  String((r.trigger as { type?: string }).type ?? ""),
                  String((r.trigger as { type?: string }).type ?? "")
                )}
                {r.conditions?.length
                  ? ` · ${t("automations.pipelineIf")} ${r.conditions.length}`
                  : ""}
                {` · ${t("automations.pipelineThen")} ${r.actions
                  ?.map((a) => metaLabel("actions", String((a as { type?: string }).type ?? ""), String((a as { type?: string }).type ?? "")))
                  .join(", ")}`}
                {(r.elseActions?.length ?? 0) > 0
                  ? ` · ${t("automations.pipelineElse")}`
                  : ""}
                {(r.onErrorActions?.length ?? 0) > 0
                  ? ` · ${t("automations.pipelineOnErr")}`
                  : ""}
              </div>
            </div>
            <button
              onClick={() => loadRuleIntoForm(r)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                editingId === r.id
                  ? "bg-amber-700 text-white"
                  : "bg-zinc-800 text-indigo-300 hover:bg-zinc-700"
              }`}
            >
              {t("automations.edit")}
            </button>
            <button
              onClick={() => void test(r)}
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            >
              {t("automations.test")}
            </button>
            <button
              onClick={() => void remove(r)}
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/40"
            >
              {t("automations.delete")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

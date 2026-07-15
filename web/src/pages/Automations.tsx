import { useEffect, useMemo, useState } from "react";
import { ItemPicker } from "../components/ItemPicker";
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

interface Blueprint {
  id: string;
  name: string;
  category: string;
  description: string;
}

interface Meta {
  triggers: MetaField[];
  actions: MetaField[];
  conditions?: MetaField[];
  templates: string[];
  blueprints?: Blueprint[];
  vars?: string[];
}

const fieldCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500";

type CondRow = { type: string; item?: string; threshold?: number; player?: string; radius?: number; comparison?: string; dimension?: string };
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
  radius?: number;
  distance?: number;
  mode?: string;
  filter?: string;
  seconds?: number;
  waypoint?: string;
};

const emptyCond = (): CondRow => ({ type: "task_idle" });
const emptyAct = (): ActRow => ({ type: "panel_notify", message: "kural tetiklendi", level: "info" });

export function Automations() {
  const bots = useAppStore((s) => s.bots);
  const servers = useAppStore((s) => s.servers);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();

  const [rules, setRules] = useState<Rule[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [showBuilder, setShowBuilder] = useState(true);
  const [bpCat, setBpCat] = useState<string>("all");

  // ── Blueprint form state ──
  const [name, setName] = useState("Yeni kural");
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
  const [actions, setActions] = useState<ActRow[]>([emptyAct()]);

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

  const blueprints = meta?.blueprints ?? [];
  const categories = useMemo(() => {
    const set = new Set(blueprints.map((b) => b.category));
    return ["all", ...[...set].sort()];
  }, [blueprints]);

  const filteredBp = blueprints.filter((b) => bpCat === "all" || b.category === bpCat);

  const triggers = meta?.triggers ?? [
    { type: "chat", label: "Sohbet / komut", fields: [] },
    { type: "item_gained", label: "Eşya geldi", fields: [] },
    { type: "item_count", label: "Eşya adedi", fields: [] },
    { type: "attacked", label: "Saldırı", fields: [] }
  ];
  const actionMeta = meta?.actions ?? [{ type: "goto", label: "Git", fields: [] }];
  const conditionMeta = meta?.conditions ?? [
    { type: "task_idle", label: "Boşta", fields: [] },
    { type: "online", label: "Online", fields: [] }
  ];

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
      return o;
    });

    const acts = actions.map((a) => {
      const o: Record<string, unknown> = { type: a.type };
      if (a.player != null && a.player !== "") o.player = a.player;
      if (a.text != null) o.text = a.text;
      if (a.message != null) o.message = a.message;
      if (a.level != null) o.level = a.level;
      if (a.item != null && a.item !== "") o.item = a.item;
      if (a.block != null && a.block !== "") o.block = a.block;
      if (a.ore != null) o.ore = a.ore;
      if (a.count != null && a.count !== "") o.count = a.count;
      if (a.radius != null) o.radius = a.radius;
      if (a.distance != null) o.distance = a.distance;
      if (a.mode != null) o.mode = a.mode;
      if (a.filter != null) o.filter = a.filter;
      if (a.seconds != null) o.seconds = a.seconds;
      if (a.waypoint != null) o.waypoint = a.waypoint;
      return o;
    });

    return {
      name,
      enabled: true,
      botIds: botIds === "all" ? "all" : [botIds],
      trigger,
      conditions: conds,
      actions: acts.length ? acts : [{ type: "panel_notify", message: "kural", level: "info" }],
      cooldownMs,
      maxTriggersPerMinute: maxPerMin
    };
  };

  const create = async () => {
    try {
      await api.post("/api/rules", buildPayload());
      await load();
      toast("success", "Kural eklendi");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const addBlueprint = async (bp: Blueprint) => {
    try {
      await api.post(`/api/rules/templates/${encodeURIComponent(bp.id)}`, {
        botIds: botIds === "all" ? "all" : [botIds]
      });
      await load();
      toast("success", `Blueprint: ${bp.name}`);
    } catch (e) {
      // id fail → isim dene
      try {
        await api.post(`/api/rules/templates/${encodeURIComponent(bp.name)}`, {
          botIds: botIds === "all" ? "all" : [botIds]
        });
        await load();
        toast("success", `Blueprint: ${bp.name}`);
      } catch (e2) {
        toast("error", e2 instanceof Error ? e2.message : String(e2));
      }
    }
  };

  const toggle = async (r: Rule) => {
    await api.patch(`/api/rules/${r.id}`, { enabled: !r.enabled });
    await load();
  };

  const remove = async (r: Rule) => {
    if (!confirm(`"${r.name}" silinsin mi?`)) return;
    await api.del(`/api/rules/${r.id}`);
    await load();
  };

  const test = async (r: Rule) => {
    const id = botIds === "all" ? Object.keys(bots)[0] : botIds;
    if (!id) {
      toast("error", "Test için bot gerekli");
      return;
    }
    try {
      await api.post(`/api/rules/${r.id}/test`, { botId: id });
      toast("info", "Kuru test — Log paneline bak");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const updateCond = (i: number, patch: Partial<CondRow>) =>
    setConditions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updateAct = (i: number, patch: Partial<ActRow>) =>
    setActions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const summaryTrigger = () => {
    if (triggerType === "chat") {
      if (match === "command") return `${commandPrefix || "/"}${pattern}`;
      return `"${pattern}" (${match})`;
    }
    if (triggerType === "item_gained") return `+${item || "herhangi"} (≥${threshold || 1})`;
    if (triggerType === "item_count") return `${item} ${comparison} ${threshold}`;
    if (triggerType === "attacked") return `saldırı · ${source}`;
    return triggerType;
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">{t("automations.title")}</h1>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
          {rules.length} kural · {blueprints.length} blueprint
        </span>
        <button
          onClick={() => void load()}
          className="ml-auto rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          {t("common.refresh")}
        </button>
        <button
          onClick={() => setShowBuilder((v) => !v)}
          className="rounded-lg bg-indigo-600/80 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
        >
          {showBuilder ? "Blueprint gizle" : "Blueprint oluşturucu"}
        </button>
      </div>

      {/* ── Blueprint galerisi ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Blueprint şablonlar</div>
          <div className="flex flex-wrap gap-1">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setBpCat(c)}
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                  bpCat === c ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {c === "all" ? "Tümü" : c}
              </button>
            ))}
          </div>
        </div>
        <p className="mb-3 text-[11px] text-zinc-500">
          Tek tıkla kural ekle: sohbet komutu, saldırı, eşya geldi/azaldı, toplama başarısı…
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredBp.map((bp) => (
            <button
              key={bp.id}
              type="button"
              onClick={() => void addBlueprint(bp)}
              className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-left transition hover:border-indigo-700/60 hover:bg-indigo-950/20"
            >
              <div className="text-[10px] font-medium tracking-wide text-indigo-400/80 uppercase">{bp.category}</div>
              <div className="mt-0.5 text-sm font-semibold text-zinc-200">{bp.name}</div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-500">{bp.description}</p>
              <div className="mt-2 text-[10px] text-indigo-400">+ Ekle</div>
            </button>
          ))}
          {filteredBp.length === 0 && (
            <p className="col-span-full text-sm text-zinc-600 italic">Blueprint yüklenemedi — sunucu meta?</p>
          )}
        </div>
      </section>

      {/* ── WHEN → IF → THEN builder ── */}
      {showBuilder && (
        <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
              <span className="text-zinc-400">Kural adı</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-400">Bot</span>
              <select value={botIds} onChange={(e) => setBotIds(e.target.value)} className={fieldCls}>
                <option value="all">Tümü</option>
                {botList.map((b) => (
                  <option key={b.config.id} value={b.config.id}>
                    {b.config.username}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex w-28 flex-col gap-1 text-sm">
              <span className="text-zinc-400">Soğuma ms</span>
              <input
                type="number"
                value={cooldownMs}
                onChange={(e) => setCooldownMs(Number(e.target.value) || 0)}
                className={fieldCls}
              />
            </label>
            <label className="flex w-28 flex-col gap-1 text-sm">
              <span className="text-zinc-400">Max/dk</span>
              <input
                type="number"
                value={maxPerMin}
                onChange={(e) => setMaxPerMin(Number(e.target.value) || 1)}
                className={fieldCls}
              />
            </label>
          </div>

          {/* Pipeline visual */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-3 py-2 text-xs">
            <span className="rounded bg-amber-950/50 px-2 py-1 font-semibold text-amber-300">WHEN</span>
            <span className="mono text-zinc-300">{summaryTrigger()}</span>
            <span className="text-zinc-600">→</span>
            <span className="rounded bg-sky-950/50 px-2 py-1 font-semibold text-sky-300">IF</span>
            <span className="text-zinc-400">{conditions.length ? conditions.map((c) => c.type).join(" · ") : "—"}</span>
            <span className="text-zinc-600">→</span>
            <span className="rounded bg-emerald-950/50 px-2 py-1 font-semibold text-emerald-300">THEN</span>
            <span className="text-zinc-400">{actions.map((a) => a.type).join(" · ")}</span>
          </div>

          {/* WHEN */}
          <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 p-3">
            <div className="mb-2 text-[10px] font-semibold tracking-wide text-amber-400/90 uppercase">
              1 · WHEN — Tetikleyici
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Tür</span>
                <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)} className={fieldCls}>
                  {triggers.map((tr) => (
                    <option key={tr.type} value={tr.type}>
                      {tr.label}
                    </option>
                  ))}
                </select>
              </label>

              {triggerType === "chat" && (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">Desen / komut adı</span>
                    <input
                      value={pattern}
                      onChange={(e) => setPattern(e.target.value)}
                      placeholder="gel | topla"
                      className={fieldCls}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">Eşleşme</span>
                    <select value={match} onChange={(e) => setMatch(e.target.value)} className={fieldCls}>
                      <option value="command">komut (/slash)</option>
                      <option value="startsWith">ile başlar</option>
                      <option value="contains">içerir</option>
                      <option value="exact">tam eşit</option>
                      <option value="regex">regex</option>
                    </select>
                  </label>
                  {match === "command" && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-400">Komut öneki</span>
                      <input
                        value={commandPrefix}
                        onChange={(e) => setCommandPrefix(e.target.value)}
                        placeholder="/"
                        className={fieldCls}
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">Kimden</span>
                    <select value={from} onChange={(e) => setFrom(e.target.value)} className={fieldCls}>
                      <option value="authorized">Yetkililer (İ3)</option>
                      <option value="anyone">Herkes</option>
                      <option value="list">Belirli kişi</option>
                    </select>
                  </label>
                </>
              )}

              {(triggerType === "chat" ||
                triggerType === "attacked" ||
                triggerType === "player_nearby" ||
                from === "list") && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">Belirli oyuncu</span>
                  <input
                    value={player}
                    onChange={(e) => setPlayer(e.target.value)}
                    placeholder="opsiyonel isim"
                    className={fieldCls}
                  />
                </label>
              )}

              {triggerType === "attacked" && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">Kaynak</span>
                  <select value={source} onChange={(e) => setSource(e.target.value)} className={fieldCls}>
                    <option value="all">Hepsi</option>
                    <option value="player">Oyuncu</option>
                    <option value="mob">Mob</option>
                  </select>
                </label>
              )}

              {(triggerType === "item_count" || triggerType === "item_gained") && (
                <>
                  <div className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">
                      {triggerType === "item_gained" ? "Eşya (boş = herhangi)" : "Eşya"}
                    </span>
                    <ItemPicker version={catalogVersion} kind="items" value={item} onChange={setItem} />
                  </div>
                  {triggerType === "item_count" && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-400">Karşılaştırma</span>
                      <select value={comparison} onChange={(e) => setComparison(e.target.value)} className={fieldCls}>
                        <option value="lt">&lt; azsa</option>
                        <option value="lte">≤</option>
                        <option value="gt">&gt; fazlaysa</option>
                        <option value="gte">≥</option>
                        <option value="eq">=</option>
                      </select>
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-zinc-400">
                      {triggerType === "item_gained" ? "Min artım" : "Eşik adet"}
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
                  <span className="text-zinc-400">Eşik</span>
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
                  <span className="text-zinc-400">Her (ms)</span>
                  <input
                    type="number"
                    value={everyMs}
                    onChange={(e) => setEveryMs(Number(e.target.value))}
                    className={fieldCls}
                  />
                </label>
              )}

              {triggerType === "player_nearby" && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">Yarıçap</span>
                  <input
                    type="number"
                    value={radius}
                    onChange={(e) => setRadius(Number(e.target.value))}
                    className={fieldCls}
                  />
                </label>
              )}

              {(triggerType === "task_done" || triggerType === "task_failed") && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">Görev tipi (opsiyonel)</span>
                  <input
                    value={taskType}
                    onChange={(e) => setTaskType(e.target.value)}
                    placeholder="collect-wood | mine | craft"
                    className={fieldCls}
                  />
                </label>
              )}
            </div>
            {match === "command" && triggerType === "chat" && (
              <p className="mt-2 text-[10px] text-amber-600/90">
                Örn. <span className="mono text-amber-400">/topla cobblestone 32</span> → pattern{" "}
                <span className="mono">topla</span>, aksiyonda item={"{arg0}"} count={"{arg1}"}
              </p>
            )}
          </div>

          {/* IF */}
          <div className="rounded-lg border border-sky-900/40 bg-sky-950/10 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold tracking-wide text-sky-400/90 uppercase">
                2 · IF — Koşullar (hepsi doğru olmalı)
              </div>
              <button
                type="button"
                onClick={() => setConditions((c) => [...c, emptyCond()])}
                className="ml-auto rounded bg-sky-900/40 px-2 py-0.5 text-[10px] text-sky-200 hover:bg-sky-900/60"
              >
                + Koşul
              </button>
            </div>
            {conditions.length === 0 && (
              <p className="text-[11px] text-zinc-600 italic">Koşul yok — tetik her zaman aksiyon çalıştırır.</p>
            )}
            <div className="space-y-2">
              {conditions.map((c, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2 rounded border border-zinc-800/80 bg-zinc-950/40 p-2">
                  <label className="flex min-w-[10rem] flex-col gap-0.5 text-xs">
                    <span className="text-zinc-500">Tür</span>
                    <select
                      value={c.type}
                      onChange={(e) => updateCond(i, { type: e.target.value })}
                      className={fieldCls}
                    >
                      {conditionMeta.map((m) => (
                        <option key={m.type} value={m.type}>
                          {m.label}
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
                  {(c.type === "health_below" ||
                    c.type === "health_above" ||
                    c.type === "food_below" ||
                    c.type === "food_above" ||
                    c.type === "item_count") && (
                    <label className="flex w-20 flex-col gap-0.5 text-xs">
                      <span className="text-zinc-500">Eşik</span>
                      <input
                        type="number"
                        value={c.threshold ?? 10}
                        onChange={(e) => updateCond(i, { threshold: Number(e.target.value) })}
                        className={fieldCls}
                      />
                    </label>
                  )}
                  {c.type === "player_near" && (
                    <>
                      <input
                        value={c.player ?? ""}
                        onChange={(e) => updateCond(i, { player: e.target.value })}
                        placeholder="oyuncu"
                        className={`${fieldCls} w-28`}
                      />
                      <input
                        type="number"
                        value={c.radius ?? 16}
                        onChange={(e) => updateCond(i, { radius: Number(e.target.value) })}
                        className={`${fieldCls} w-20`}
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
                  <button
                    type="button"
                    onClick={() => setConditions((rows) => rows.filter((_, j) => j !== i))}
                    className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* THEN */}
          <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold tracking-wide text-emerald-400/90 uppercase">
                3 · THEN — Aksiyonlar (sırayla)
              </div>
              <button
                type="button"
                onClick={() => setActions((a) => [...a, emptyAct()])}
                className="ml-auto rounded bg-emerald-900/40 px-2 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-900/60"
              >
                + Aksiyon
              </button>
            </div>
            <div className="space-y-2">
              {actions.map((a, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2 rounded border border-zinc-800/80 bg-zinc-950/40 p-2">
                  <span className="self-center text-[10px] text-zinc-600">{i + 1}.</span>
                  <label className="flex min-w-[11rem] flex-col gap-0.5 text-xs">
                    <span className="text-zinc-500">Aksiyon</span>
                    <select
                      value={a.type}
                      onChange={(e) => updateAct(i, { type: e.target.value })}
                      className={fieldCls}
                    >
                      {actionMeta.map((m) => (
                        <option key={m.type} value={m.type}>
                          {m.category ? `${m.category}: ` : ""}
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {["goto", "follow", "attack", "protect", "social-follow", "social-attack"].includes(a.type) && (
                    <input
                      value={a.player ?? "{player}"}
                      onChange={(e) => updateAct(i, { player: e.target.value })}
                      placeholder="{player} / {arg0}"
                      className={`${fieldCls} w-36`}
                    />
                  )}
                  {a.type === "send_chat" && (
                    <input
                      value={a.text ?? ""}
                      onChange={(e) => updateAct(i, { text: e.target.value })}
                      placeholder="mesaj"
                      className={`${fieldCls} min-w-[12rem] flex-1`}
                    />
                  )}
                  {a.type === "panel_notify" && (
                    <input
                      value={a.message ?? ""}
                      onChange={(e) => updateAct(i, { message: e.target.value })}
                      placeholder="bildirim"
                      className={`${fieldCls} min-w-[12rem] flex-1`}
                    />
                  )}
                  {["collect", "collect_item", "craft", "withdraw", "mine"].includes(a.type) && (
                    <>
                      {a.type === "mine" ? (
                        <ItemPicker
                          version={catalogVersion}
                          kind="ores"
                          value={String(a.ore ?? "iron")}
                          onChange={(n) => updateAct(i, { ore: n.replace(/_ore$/, "") })}
                        />
                      ) : (
                        <ItemPicker
                          version={catalogVersion}
                          kind={a.type === "collect" || a.type === "collect_item" ? "blocks" : "items"}
                          value={String(a.item ?? a.block ?? "oak_log")}
                          onChange={(n) => updateAct(i, { item: n, block: n })}
                        />
                      )}
                      <input
                        value={a.count ?? 16}
                        onChange={(e) => updateAct(i, { count: e.target.value })}
                        placeholder="adet / {arg1}"
                        className={`${fieldCls} w-24`}
                      />
                    </>
                  )}
                  {["clear-mobs", "hunt", "collect_drops"].includes(a.type) && (
                    <input
                      type="number"
                      value={a.radius ?? 16}
                      onChange={(e) => updateAct(i, { radius: Number(e.target.value) })}
                      className={`${fieldCls} w-20`}
                      title="yarıçap"
                    />
                  )}
                  {a.type === "wait" && (
                    <input
                      type="number"
                      value={a.seconds ?? 1}
                      onChange={(e) => updateAct(i, { seconds: Number(e.target.value) })}
                      className={`${fieldCls} w-20`}
                      title="saniye"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setActions((rows) => rows.filter((_, j) => j !== i))}
                    className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void create()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Kuralı kaydet
            </button>
            <p className="text-[10px] text-zinc-600">
              Değişkenler: {(meta?.vars ?? ["{player}", "{arg0}", "{item}", "{delta}"]).join(" ")}
            </p>
          </div>
        </section>
      )}

      {/* ── Mevcut kurallar ── */}
      <div className="space-y-2">
        {rules.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 py-12 text-zinc-500">
            <span className="text-3xl">⚙️</span>
            <p className="text-sm">Henüz kural yok. Blueprint ekle veya oluşturucu kullan.</p>
          </div>
        )}
        {rules.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3"
          >
            <button
              onClick={() => void toggle(r)}
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                r.enabled ? "bg-emerald-950/60 text-emerald-300" : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {r.enabled ? "AÇIK" : "KAPALI"}
            </button>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-zinc-200">{r.name}</div>
              <div className="mono mt-0.5 truncate text-[11px] text-zinc-500">
                WHEN {(r.trigger as { type?: string }).type}
                {r.conditions?.length ? ` · IF ${r.conditions.length}` : ""}
                {` · THEN ${r.actions?.map((a) => (a as { type?: string }).type).join(", ")}`}
              </div>
            </div>
            <button
              onClick={() => void test(r)}
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Test
            </button>
            <button
              onClick={() => void remove(r)}
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/40"
            >
              Sil
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

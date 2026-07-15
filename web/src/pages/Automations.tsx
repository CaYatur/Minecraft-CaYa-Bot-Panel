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

interface Meta {
  triggers: Array<{ type: string; label: string; fields: string[] }>;
  actions: Array<{ type: string; label: string; fields: string[] }>;
  templates: string[];
}

const fieldCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500";

const emptyForm = () => ({
  name: "Yeni kural",
  botIds: "all" as string | "all",
  triggerType: "chat",
  pattern: "gel",
  match: "contains",
  from: "authorized",
  player: "",
  threshold: 10,
  everyMs: 60000,
  radius: 16,
  source: "all",
  item: "oak_log",
  ore: "iron",
  comparison: "lt",
  actionType: "goto",
  actionPlayer: "{player}",
  actionText: "as {player}",
  actionCount: 16,
  actionMode: "legit",
  actionMessage: "kural tetiklendi",
  cooldownMs: 3000
});

export function Automations() {
  const bots = useAppStore((s) => s.bots);
  const servers = useAppStore((s) => s.servers);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();
  const [rules, setRules] = useState<Rule[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showBuilder, setShowBuilder] = useState(true);

  const botList = Object.values(bots);
  const catalogVersion = useMemo(() => {
    if (form.botIds !== "all" && form.botIds) {
      const b = bots[form.botIds];
      const srv = servers.find((s) => s.id === b?.config.serverId);
      return srv?.version ?? "auto";
    }
    return servers[0]?.version ?? "auto";
  }, [form.botIds, bots, servers]);

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

  const setF = <K extends keyof ReturnType<typeof emptyForm>>(k: K, v: ReturnType<typeof emptyForm>[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const buildPayload = (): Partial<Rule> => {
    const trigger: Record<string, unknown> = { type: form.triggerType };
    if (form.triggerType === "chat") {
      trigger.pattern = form.pattern;
      trigger.match = form.match;
      trigger.from = form.from === "list" && form.player ? [form.player] : form.from;
      if (form.player && form.from !== "list") trigger.player = form.player;
    }
    if (form.triggerType === "attacked") {
      trigger.source = form.source;
      if (form.player) trigger.player = form.player;
    }
    if (form.triggerType === "player_nearby") {
      trigger.radius = form.radius;
      if (form.player) trigger.player = form.player;
      if (form.from === "authorized") trigger.from = "authorized";
    }
    if (form.triggerType === "health_below" || form.triggerType === "food_below") {
      trigger.threshold = form.threshold;
    }
    if (form.triggerType === "interval") trigger.everyMs = form.everyMs;
    if (form.triggerType === "item_count") {
      trigger.item = form.item;
      trigger.comparison = form.comparison;
      trigger.threshold = form.threshold;
    }

    const action: Record<string, unknown> = { type: form.actionType };
    if (["goto", "follow", "attack"].includes(form.actionType)) {
      action.player = form.actionPlayer || "{player}";
    }
    if (form.actionType === "send_chat") action.text = form.actionText;
    if (form.actionType === "panel_notify") {
      action.message = form.actionMessage;
      action.level = "info";
    }
    if (form.actionType === "collect" || form.actionType === "collect_wood") {
      action.count = form.actionCount;
      action.block = form.item;
    }
    if (form.actionType === "mine") {
      action.ore = form.ore;
      action.count = form.actionCount;
      action.mode = form.actionMode;
    }
    if (form.actionType === "craft") {
      action.item = form.item;
      action.count = form.actionCount;
    }
    if (form.actionType === "hunt" || form.actionType === "clear-mobs" || form.actionType === "clear_mobs") {
      action.radius = form.radius;
    }
    if (form.actionType === "follow") action.distance = 3;

    return {
      name: form.name,
      enabled: true,
      botIds: form.botIds === "all" ? "all" : [form.botIds],
      trigger: trigger as Rule["trigger"],
      conditions: form.triggerType === "interval" ? [{ type: "task_idle" }, { type: "online" }] : [],
      actions: [action],
      cooldownMs: form.cooldownMs,
      maxTriggersPerMinute: 10
    };
  };

  const create = async () => {
    try {
      await api.post("/api/rules", buildPayload());
      await load();
      toast("success", "Kural eklendi");
      setForm(emptyForm());
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const addTemplate = async (tpl: string) => {
    try {
      await api.post(`/api/rules/templates/${encodeURIComponent(tpl)}`, {
        botIds: form.botIds === "all" ? "all" : [form.botIds]
      });
      await load();
      toast("success", `Şablon: ${tpl}`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
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
    const id = form.botIds === "all" ? Object.keys(bots)[0] : form.botIds;
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

  const templates = meta?.templates?.length
    ? meta.templates
    : ["Gel komutu", "Beni koru", "Oduncu", "Yemek nöbetçisi", "Hoş geldin"];

  const triggerNeedsItem = form.triggerType === "item_count";
  const actionNeedsItem = ["craft", "collect", "collect_wood", "withdraw"].includes(form.actionType);
  const actionNeedsOre = form.actionType === "mine";

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">{t("automations.title")}</h1>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
          {rules.length} kural · katalog {catalogVersion}
        </span>
        <button
          onClick={() => void load()}
          className="ml-auto rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          Yenile
        </button>
        <button
          onClick={() => setShowBuilder((v) => !v)}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          {showBuilder ? "Formu gizle" : "Yeni kural formu"}
        </button>
      </div>

      {showBuilder && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Kural oluşturucu</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-400">Kural adı</span>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} className={fieldCls} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-400">Bot</span>
              <select value={form.botIds} onChange={(e) => setF("botIds", e.target.value)} className={fieldCls}>
                <option value="all">Tümü</option>
                {botList.map((b) => (
                  <option key={b.config.id} value={b.config.id}>
                    {b.config.username}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-400">Soğuma (ms)</span>
              <input
                type="number"
                value={form.cooldownMs}
                onChange={(e) => setF("cooldownMs", Number(e.target.value) || 0)}
                className={fieldCls}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-400">Tetikleyici</span>
              <select value={form.triggerType} onChange={(e) => setF("triggerType", e.target.value)} className={fieldCls}>
                {(meta?.triggers ?? [
                  { type: "chat", label: "Sohbet" },
                  { type: "attacked", label: "Saldırıya uğradı" },
                  { type: "player_nearby", label: "Yakında oyuncu" },
                  { type: "health_below", label: "Can düşük" },
                  { type: "food_below", label: "Açlık düşük" },
                  { type: "item_count", label: "Eşya adedi" },
                  { type: "interval", label: "Zamanlayıcı" },
                  { type: "inventory_full", label: "Envanter dolu" },
                  { type: "player_joined", label: "Oyuncu girdi" },
                  { type: "bot_died", label: "Bot öldü" }
                ]).map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            {form.triggerType === "chat" && (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">Desen (mesaj)</span>
                  <input value={form.pattern} onChange={(e) => setF("pattern", e.target.value)} className={fieldCls} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">Eşleşme</span>
                  <select value={form.match} onChange={(e) => setF("match", e.target.value)} className={fieldCls}>
                    <option value="contains">içerir</option>
                    <option value="exact">tam</option>
                    <option value="regex">regex</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-400">Kimden</span>
                  <select value={form.from} onChange={(e) => setF("from", e.target.value)} className={fieldCls}>
                    <option value="authorized">Yetkililer (İ3)</option>
                    <option value="anyone">Herkes</option>
                    <option value="list">Belirli kişi</option>
                  </select>
                </label>
              </>
            )}

            {(form.triggerType === "chat" ||
              form.triggerType === "attacked" ||
              form.triggerType === "player_nearby" ||
              form.from === "list") && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Belirli oyuncu (opsiyonel)</span>
                <input
                  value={form.player}
                  onChange={(e) => setF("player", e.target.value)}
                  placeholder="CaYatur"
                  className={fieldCls}
                />
              </label>
            )}

            {(form.triggerType === "health_below" ||
              form.triggerType === "food_below" ||
              form.triggerType === "item_count") && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Eşik</span>
                <input
                  type="number"
                  value={form.threshold}
                  onChange={(e) => setF("threshold", Number(e.target.value))}
                  className={fieldCls}
                />
              </label>
            )}

            {form.triggerType === "interval" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Her (ms)</span>
                <input
                  type="number"
                  value={form.everyMs}
                  onChange={(e) => setF("everyMs", Number(e.target.value))}
                  className={fieldCls}
                />
              </label>
            )}

            {(form.triggerType === "player_nearby" || form.actionType === "hunt") && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Yarıçap</span>
                <input
                  type="number"
                  value={form.radius}
                  onChange={(e) => setF("radius", Number(e.target.value))}
                  className={fieldCls}
                />
              </label>
            )}

            {form.triggerType === "attacked" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Kaynak</span>
                <select value={form.source} onChange={(e) => setF("source", e.target.value)} className={fieldCls}>
                  <option value="all">Hepsi</option>
                  <option value="player">Oyuncu</option>
                  <option value="mob">Mob</option>
                </select>
              </label>
            )}

            {triggerNeedsItem && (
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Eşya (katalog)</span>
                <ItemPicker version={catalogVersion} kind="items" value={form.item} onChange={(n) => setF("item", n)} />
              </div>
            )}

            {form.triggerType === "item_count" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Karşılaştırma</span>
                <select value={form.comparison} onChange={(e) => setF("comparison", e.target.value)} className={fieldCls}>
                  <option value="lt">&lt;</option>
                  <option value="lte">≤</option>
                  <option value="gt">&gt;</option>
                  <option value="gte">≥</option>
                  <option value="eq">=</option>
                </select>
              </label>
            )}

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-400">Aksiyon</span>
              <select value={form.actionType} onChange={(e) => setF("actionType", e.target.value)} className={fieldCls}>
                {(meta?.actions ?? [
                  { type: "goto", label: "Git (oyuncu)" },
                  { type: "follow", label: "Takip" },
                  { type: "attack", label: "Saldır" },
                  { type: "mine", label: "Maden" },
                  { type: "collect", label: "Odun topla" },
                  { type: "craft", label: "Üret" },
                  { type: "send_chat", label: "Sohbet" },
                  { type: "eat", label: "Ye" },
                  { type: "flee", label: "Kaç" },
                  { type: "panel_notify", label: "Panel bildir" }
                ]).map((a) => (
                  <option key={a.type} value={a.type}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>

            {["goto", "follow", "attack"].includes(form.actionType) && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Hedef oyuncu</span>
                <input
                  value={form.actionPlayer}
                  onChange={(e) => setF("actionPlayer", e.target.value)}
                  placeholder="{player} veya isim"
                  className={fieldCls}
                />
              </label>
            )}

            {form.actionType === "send_chat" && (
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span className="text-zinc-400">Mesaj</span>
                <input value={form.actionText} onChange={(e) => setF("actionText", e.target.value)} className={fieldCls} />
              </label>
            )}

            {actionNeedsOre && (
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Maden (katalog)</span>
                <ItemPicker version={catalogVersion} kind="ores" value={form.ore} onChange={(n) => setF("ore", n.replace(/_ore$/, ""))} />
              </div>
            )}

            {actionNeedsItem && (
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Eşya / blok (katalog)</span>
                <ItemPicker
                  version={catalogVersion}
                  kind={form.actionType === "collect" || form.actionType === "collect_wood" ? "blocks" : "items"}
                  value={form.item}
                  onChange={(n) => setF("item", n)}
                />
              </div>
            )}

            {["mine", "collect", "craft", "collect_wood"].includes(form.actionType) && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Adet</span>
                <input
                  type="number"
                  value={form.actionCount}
                  onChange={(e) => setF("actionCount", Number(e.target.value) || 1)}
                  className={fieldCls}
                />
              </label>
            )}

            {form.actionType === "mine" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Mod</span>
                <select value={form.actionMode} onChange={(e) => setF("actionMode", e.target.value)} className={fieldCls}>
                  <option value="legit">legit</option>
                  <option value="utility">utility</option>
                </select>
              </label>
            )}
          </div>

          <p className="mt-3 text-[11px] text-zinc-500">
            Özet: <span className="text-zinc-300">{form.triggerType}</span>
            {form.pattern ? ` “${form.pattern}”` : ""} → <span className="text-zinc-300">{form.actionType}</span>
            {form.actionPlayer ? ` (${form.actionPlayer})` : ""} · değişkenler: {"{player}"} {"{attacker}"} {"{item}"}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => void create()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Kuralı kaydet
            </button>
          </div>

          <div className="mt-4 border-t border-zinc-800 pt-3">
            <div className="mb-2 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Hazır şablonlar</div>
            <div className="flex flex-wrap gap-1.5">
              {templates.map((t) => (
                <button
                  key={t}
                  onClick={() => void addTemplate(t!)}
                  className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
                >
                  + {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rules.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 py-12 text-zinc-500">
            <span className="text-3xl">⚙️</span>
            <p className="text-sm">Henüz kural yok. Formdan oluştur veya şablon ekle.</p>
          </div>
        )}
        {rules.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3"
          >
            <button
              onClick={() => void toggle(r)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                r.enabled ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {r.enabled ? "Açık" : "Kapalı"}
            </button>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-zinc-100">{r.name}</div>
              <div className="mono text-[11px] text-zinc-500">
                {String(r.trigger?.type ?? "?")}
                {r.trigger?.pattern ? ` · ${String(r.trigger.pattern)}` : ""}
                {r.trigger?.player ? ` · kişi:${String(r.trigger.player)}` : ""}
                {r.trigger?.ore ? ` · ore:${String(r.trigger.ore)}` : ""}
                {" · "}
                {r.actions.map((a) => String(a.type)).join(" → ")}
              </div>
            </div>
            <button
              onClick={() => void test(r)}
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-amber-300 hover:bg-zinc-700"
            >
              Test
            </button>
            <button
              onClick={() => void remove(r)}
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-red-300 hover:bg-zinc-700"
            >
              Sil
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

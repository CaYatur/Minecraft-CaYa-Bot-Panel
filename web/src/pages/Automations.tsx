import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  botIds: string[] | "all";
  trigger: { type: string; pattern?: string; match?: string; from?: string | string[]; threshold?: number; everyMs?: number };
  conditions: unknown[];
  actions: Array<{ type: string; [k: string]: unknown }>;
  cooldownMs: number;
  maxTriggersPerMinute: number;
}

const TEMPLATES = ["Gel komutu", "Beni koru", "Oduncu", "Yemek nöbetçisi", "Hoş geldin"];

export function Automations() {
  const bots = useAppStore((s) => s.bots);
  const toast = useAppStore((s) => s.toast);
  const [rules, setRules] = useState<Rule[]>([]);
  const [name, setName] = useState("Gel komutu");
  const [pattern, setPattern] = useState("gel");
  const [botId, setBotId] = useState("all");

  const load = async () => {
    const list = await api.get<Rule[]>("/api/rules");
    setRules(list);
  };

  useEffect(() => {
    void load().catch(() => {});
  }, []);

  const createCustom = async () => {
    try {
      await api.post("/api/rules", {
        name,
        enabled: true,
        botIds: botId === "all" ? "all" : [botId],
        trigger: { type: "chat", pattern, match: "contains", from: "authorized" },
        actions: [{ type: "goto", player: "{player}" }, { type: "panel_notify", message: `{player} → gel`, level: "info" }],
        cooldownMs: 2000
      });
      await load();
      toast("success", "Kural eklendi");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const addTemplate = async (tpl: string) => {
    try {
      await api.post(`/api/rules/templates/${encodeURIComponent(tpl)}`, { botIds: botId === "all" ? "all" : [botId] });
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
    const id = botId === "all" ? Object.keys(bots)[0] : botId;
    if (!id) {
      toast("error", "Test için bot gerekli");
      return;
    }
    try {
      await api.post(`/api/rules/${r.id}/test`, { botId: id });
      toast("info", "Kuru test çalıştı — Log paneline bak");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const exportJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(rules, null, 2));
    toast("success", "Kurallar panoya kopyalandı");
  };

  const botList = Object.values(bots);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">Otomasyonlar</h1>
        <span className="text-xs text-zinc-500">RuleEngine · İ3 yetkili listesi · cooldown/spam koruması</span>
        <button onClick={() => void load()} className="ml-auto rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">
          Yenile
        </button>
        <button onClick={exportJson} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">
          JSON Kopyala
        </button>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Yeni kural / şablon</div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Ad
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Sohbet deseni
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Bot
            <select value={botId} onChange={(e) => setBotId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100">
              <option value="all">Tümü</option>
              {botList.map((b) => (
                <option key={b.config.id} value={b.config.id}>
                  {b.config.username}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => void createCustom()} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500">
            Chat→Git kuralı ekle
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {TEMPLATES.map((t) => (
            <button key={t} onClick={() => void addTemplate(t)} className="rounded-full bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700">
              + {t}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          Özet: <b className="text-zinc-300">yetkili</b> sohbete <b className="text-zinc-300">&quot;{pattern}&quot;</b> yazarsa →{" "}
          <b className="text-zinc-300">ona git</b> (varsayılan şablon).
        </p>
      </div>

      <div className="space-y-2">
        {rules.length === 0 && <div className="py-12 text-center text-sm text-zinc-600">Henüz kural yok</div>}
        {rules.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
            <button
              onClick={() => void toggle(r)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${r.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}
            >
              {r.enabled ? "Açık" : "Kapalı"}
            </button>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-zinc-100">{r.name}</div>
              <div className="mono text-[11px] text-zinc-500">
                {r.trigger.type}
                {r.trigger.pattern ? ` · ${r.trigger.pattern}` : ""} · {r.actions.map((a) => a.type).join(" → ")}
              </div>
            </div>
            <button onClick={() => void test(r)} className="rounded bg-zinc-800 px-2 py-1 text-xs text-amber-300 hover:bg-zinc-700">
              Test
            </button>
            <button onClick={() => void remove(r)} className="rounded bg-zinc-800 px-2 py-1 text-xs text-red-300 hover:bg-zinc-700">
              Sil
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

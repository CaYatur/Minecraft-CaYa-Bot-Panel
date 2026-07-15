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

/** Faz 11 — Otomasyonlar. Sayfa dili: Servers.tsx (zinc-900/50 xl kart, indigo birincil). */
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
        actions: [
          { type: "goto", player: "{player}" },
          { type: "panel_notify", message: `{player} → gel`, level: "info" }
        ],
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
      await api.post(`/api/rules/templates/${encodeURIComponent(tpl)}`, {
        botIds: botId === "all" ? "all" : [botId]
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
  const fieldCls =
    "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500";

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">Otomasyonlar</h1>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
          {rules.length} kural · İ3 yetkili listesi
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => void load()}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
          >
            Yenile
          </button>
          <button
            onClick={exportJson}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
          >
            JSON Kopyala
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Yeni kural / şablon</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Ad</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`w-44 ${fieldCls}`} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Sohbet deseni</span>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} className={`w-36 ${fieldCls}`} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Bot</span>
            <select value={botId} onChange={(e) => setBotId(e.target.value)} className={`w-40 ${fieldCls}`}>
              <option value="all">Tümü</option>
              {botList.map((b) => (
                <option key={b.config.id} value={b.config.id}>
                  {b.config.username}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => void createCustom()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Chat→Git kuralı ekle
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {TEMPLATES.map((t) => (
            <button
              key={t}
              onClick={() => void addTemplate(t)}
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              + {t}
            </button>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Özet: <span className="text-zinc-300">yetkili</span> sohbete{" "}
          <span className="text-zinc-300">&quot;{pattern}&quot;</span> yazarsa →{" "}
          <span className="text-zinc-300">ona git</span> (varsayılan şablon). Hatalı kural motoru çökertmez.
        </p>
      </div>

      <div className="space-y-2">
        {rules.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 py-12 text-zinc-500">
            <span className="text-3xl">⚙️</span>
            <p className="text-sm">Henüz kural yok. Şablon ekle veya Chat→Git oluştur.</p>
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
                {r.trigger.type}
                {r.trigger.pattern ? ` · ${r.trigger.pattern}` : ""} · {r.actions.map((a) => a.type).join(" → ")}
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

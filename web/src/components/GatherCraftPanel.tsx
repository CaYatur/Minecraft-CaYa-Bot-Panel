import { useState } from "react";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";

export function GatherCraftPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const [woodN, setWoodN] = useState("16");
  const [ore, setOre] = useState("iron");
  const [oreN, setOreN] = useState("8");
  const [mode, setMode] = useState<"legit" | "utility">("legit");
  const [craftItem, setCraftItem] = useState("stick");
  const [craftN, setCraftN] = useState("1");
  const [plan, setPlan] = useState<Array<{ kind: string; item: string; count: number; note?: string }>>([]);

  if (!bot) return null;
  const online = bot.status === "online";

  const act = async (action: Record<string, unknown>, msg?: string) => {
    try {
      await api.post(`/api/bots/${botId}/action`, action);
      if (msg) toast("info", msg);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const loadPlan = async () => {
    try {
      const r = await api.get<{ plan: typeof plan }>(`/api/bots/${botId}/craft-plan?item=${encodeURIComponent(craftItem)}&count=${craftN}`);
      setPlan(r.plan ?? []);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Toplama (Faz 8)</div>
          <div className="flex flex-wrap gap-2">
            <input value={woodN} onChange={(e) => setWoodN(e.target.value)} className="mono w-16 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
            <button
              disabled={!online}
              onClick={() => act({ type: "collect-wood", count: Number(woodN) || 16 }, "Odun toplama")}
              className="rounded-lg bg-emerald-800/50 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-800/70 disabled:opacity-40"
            >
              Odun Topla
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "collect-drops", radius: 16 }, "Yerdeki eşya")}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
            >
              Eşya Topla
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input value={ore} onChange={(e) => setOre(e.target.value)} placeholder="ore" className="w-28 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
            <input value={oreN} onChange={(e) => setOreN(e.target.value)} className="mono w-14 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "legit" | "utility")}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300"
            >
              <option value="legit">legit</option>
              <option value="utility">utility ⚠</option>
            </select>
            <button
              disabled={!online}
              onClick={() => act({ type: "mine", ore, count: Number(oreN) || 8, mode }, `Maden: ${ore}`)}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-amber-200 hover:bg-zinc-700 disabled:opacity-40"
            >
              Maden Topla
            </button>
          </div>
          {mode === "utility" && <p className="mt-2 text-[10px] text-amber-400">Utility mod gerçekçi değil — bilinçli açılır.</p>}
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Üret (Faz 9)</div>
          <div className="flex flex-wrap gap-2">
            <input value={craftItem} onChange={(e) => setCraftItem(e.target.value)} className="w-36 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
            <input value={craftN} onChange={(e) => setCraftN(e.target.value)} className="mono w-14 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
            <button onClick={() => void loadPlan()} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700">
              Plan Önizle
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "craft", item: craftItem, count: Number(craftN) || 1 }, `Üret: ${craftItem}`)}
              className="rounded-lg bg-indigo-600/80 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Onayla &amp; Kuyruğa
            </button>
          </div>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {plan.length === 0 && <div className="text-xs text-zinc-600 italic">Plan yok — önizle</div>}
            {plan.map((p, i) => (
              <div key={i} className="mono text-[11px] text-zinc-400">
                {i + 1}. {p.kind} · {p.item}×{p.count}
                {p.note ? ` (${p.note})` : ""}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Depo (Faz 10)</div>
        <div className="flex flex-wrap gap-2">
          <button disabled={!online} onClick={() => act({ type: "deposit" }, "Depoya bırak")} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:opacity-40">
            Depoya Bırak
          </button>
          <button
            disabled={!online}
            onClick={() => {
              const item = prompt("Eşya adı?");
              if (item) void act({ type: "withdraw", item, count: 16 });
            }}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:opacity-40"
          >
            Depodan Al
          </button>
          <button
            disabled={!online}
            onClick={() => {
              const item = prompt("Getirilecek eşya?");
              const player = prompt("Kime (oyuncu)?") || "";
              if (item) void act({ type: "fetch", item, count: 8, player });
            }}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:opacity-40"
          >
            Getir
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { api } from "../lib/api";
import type { StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

export function SurvivalPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const [radius, setRadius] = useState("32");

  if (!bot) return null;
  const s = bot.config.survival;
  const online = bot.status === "online";

  const refresh = async () => applySnapshot(await api.get<StateSnapshot>("/api/state"));
  const patch = async (survival: Record<string, unknown>) => {
    try {
      await api.patch(`/api/bots/${botId}`, { survival });
      await refresh();
      toast("success", "Hayatta kalma ayarı kaydedildi");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  const act = async (action: Record<string, unknown>, msg?: string) => {
    try {
      await api.post(`/api/bots/${botId}/action`, action);
      if (msg) toast("info", msg);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const foods =
    bot.inventory?.slots.filter((x) => x && (x.name.includes("cooked") || x.name.includes("bread") || x.name.includes("apple") || x.name.includes("beef") || x.name.includes("pork") || x.name.includes("chicken") || x.name.includes("carrot") || x.name.includes("potato") || x.name.includes("berry"))) ??
    [];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Beslenme</div>
          <div className="mono mb-2 text-sm text-zinc-300">
            Açlık {bot.runtime.food}/20 · Doyma {bot.runtime.foodSaturation.toFixed(1)} · Can {bot.runtime.health}
          </div>
          <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={s.autoEat} onChange={(e) => void patch({ autoEat: e.target.checked })} />
            Otomatik ye
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Ye eşiği (açlık)
            <input
              type="number"
              min={1}
              max={20}
              defaultValue={s.eatAtFood}
              onBlur={(e) => void patch({ eatAtFood: Number(e.target.value) || 14 })}
              className="mono w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              disabled={!online}
              onClick={() => act({ type: "eat" }, "Yeme kuyruğa")}
              className="rounded-lg bg-amber-700/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-700/60 disabled:opacity-40"
            >
              Şimdi Ye
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "hunt", radius: Number(radius) || 32 }, "Av başlatıldı")}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
            >
              Avlan
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "cook" }, "Pişirme kuyruğa")}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
            >
              Pişir
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "acquire-food" }, "Yemek edin akışı")}
              className="rounded-lg bg-indigo-600/70 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Yemek Edin (av+pişir+ye)
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] text-zinc-500">Av yarıçapı</span>
            <input value={radius} onChange={(e) => setRadius(e.target.value)} className="mono w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs" />
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Eldeki yiyecekler</div>
          <div className="flex flex-wrap gap-1">
            {foods.length === 0 && <span className="text-xs text-zinc-600 italic">yiyecek yok / envanter bilinmiyor</span>}
            {foods.map(
              (f) =>
                f && (
                  <span key={f.slot} className="mono rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    {f.displayName}×{f.count}
                  </span>
                )
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
            Otomatik yeme blacklist: {s.foodBlacklist?.slice(0, 4).join(", ")}…
            Dövüşte yalnızca can kritikse yer. Av RealismLayer ile (Faz 6).
          </p>
        </div>
      </div>
    </div>
  );
}

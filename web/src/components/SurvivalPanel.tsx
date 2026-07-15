import { useState } from "react";
import { api } from "../lib/api";
import type { StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

/** Faz 7 — Hayatta kalma. Tasarım dili: InventoryPanel / TasksPanel (zinc kart + indigo birincil). */
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
    bot.inventory?.slots.filter(
      (x) =>
        x &&
        (x.name.includes("cooked") ||
          x.name.includes("bread") ||
          x.name.includes("apple") ||
          x.name.includes("beef") ||
          x.name.includes("pork") ||
          x.name.includes("chicken") ||
          x.name.includes("carrot") ||
          x.name.includes("potato") ||
          x.name.includes("berry"))
    ) ?? [];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {!online && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          Bot çevrimdışı — ayarlar kaydedilir; yeme/av/pişirme bot online iken çalışır.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Beslenme</div>
          <div className="mono mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
            <span>
              Açlık <b className="text-zinc-200">{bot.runtime.food}</b>/20
            </span>
            <span className="text-zinc-600">·</span>
            <span>
              Doyma <b className="text-zinc-200">{bot.runtime.foodSaturation.toFixed(1)}</b>
            </span>
            <span className="text-zinc-600">·</span>
            <span>
              Can <b className="text-zinc-200">{bot.runtime.health}</b>
            </span>
          </div>

          <label className="mb-3 flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={s.autoEat} onChange={(e) => void patch({ autoEat: e.target.checked })} />
            Otomatik ye
          </label>

          <label className="mb-3 flex flex-col gap-1 text-xs text-zinc-400">
            Ye eşiği (açlık)
            <input
              type="number"
              min={1}
              max={20}
              defaultValue={s.eatAtFood}
              onBlur={(e) => void patch({ eatAtFood: Number(e.target.value) || 14 })}
              className="mono w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              disabled={!online}
              onClick={() => act({ type: "eat" }, "Yeme kuyruğa")}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-amber-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              Şimdi Ye
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "hunt", radius: Number(radius) || 32 }, "Av başlatıldı")}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              Avlan
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "cook" }, "Pişirme kuyruğa")}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              Pişir
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "acquire-food" }, "Yemek edin akışı")}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Yemek Edin
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[10px] text-zinc-500">Av yarıçapı</span>
            <input
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              className="mono w-16 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
          </div>
          <p className="mono mt-2 text-[10px] text-zinc-600">komut: ye · av [yarıçap] · …</p>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Eldeki yiyecekler</div>
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
          <div className="mt-3 mb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Blacklist (otomatik yenmez)</div>
          <div className="flex flex-wrap gap-1">
            {(s.foodBlacklist ?? []).length === 0 && <span className="text-xs text-zinc-600 italic">yok</span>}
            {(s.foodBlacklist ?? []).map((n) => (
              <span key={n} className="mono rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {n}
              </span>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
            Dövüşte yalnızca can kritikse yer. Av RealismLayer ile (Faz 6). Sistem mesajları sohbete yazılmaz (İ1).
          </p>
        </div>
      </div>
    </div>
  );
}

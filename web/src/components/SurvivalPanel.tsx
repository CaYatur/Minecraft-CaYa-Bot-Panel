import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { EV } from "../lib/events";
import { socket } from "../lib/socket";
import type { StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

interface FallGuardLive {
  active: boolean;
  falling: boolean;
  method: string | null;
  fallDistance: number;
  remainingBlocks: number;
  predictedDamage: number;
  lethal: boolean;
  lastAction: string;
  inventoryOptions: string[];
}

const defaultFg = {
  enabled: true,
  minDamageHp: 4,
  lethalHealthMargin: 2,
  mlgTriggerBlocks: 5.5,
  onlyWhenDangerous: true,
  autoReclaim: true,
  reclaimWater: true,
  reclaimBoat: true,
  reclaimBlocks: true
};

const defaultWg = {
  enabled: true,
  surfaceOxygenBelow: 14,
  seekLand: true,
  landSearchRadius: 16
};

const defaultHg = {
  enabled: true,
  escapeRadius: 12,
  seekWater: true,
  useWaterBucket: true
};

const defaultScoop = {
  enabled: false,
  scoopWater: true,
  scoopLava: false,
  radius: 3,
  cooldownMs: 2500
};

/** Faz 7 — Hayatta kalma + düşüş kurtarma (MLG). */
export function SurvivalPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const [radius, setRadius] = useState("32");
  const [fgLive, setFgLive] = useState<FallGuardLive | null>(null);

  useEffect(() => {
    const onFg = (p: { botId: string; fallGuard: FallGuardLive }) => {
      if (p.botId === botId) setFgLive(p.fallGuard);
    };
    socket.on(EV.BOT_FALL_GUARD, onFg);
    return () => {
      socket.off(EV.BOT_FALL_GUARD, onFg);
    };
  }, [botId]);

  if (!bot) return null;
  const s = bot.config.survival;
  const fg = { ...defaultFg, ...(s.fallGuard ?? {}) };
  const wg = { ...defaultWg, ...(s.waterGuard ?? {}) };
  const hg = { ...defaultHg, ...(s.hazardGuard ?? {}) };
  const scoop = { ...defaultScoop, ...(s.bucketScoop ?? {}) };
  const mov = bot.config.movement;
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
  const patchMove = async (movement: Record<string, unknown>) => {
    try {
      await api.patch(`/api/bots/${botId}`, { movement });
      await refresh();
      toast("success", "Hareket / parkur ayarı kaydedildi");
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

      {/* Düşüş kurtarma / MLG */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Düşüş kurtarma (MLG)</span>
          {fgLive?.falling && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                fgLive.lethal ? "bg-red-950/70 text-red-300" : "bg-amber-950/60 text-amber-300"
              }`}
            >
              {fgLive.lethal ? "ÖLÜMCÜL DÜŞÜŞ" : "düşüyor"} · ≈{fgLive.predictedDamage} HP · {fgLive.remainingBlocks}m
            </span>
          )}
          {fgLive?.active && (
            <span className="rounded-full bg-indigo-950/60 px-2 py-0.5 text-[10px] text-indigo-300">
              {fgLive.method ?? "MLG"}…
            </span>
          )}
        </div>

        <label className="mb-3 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={fg.enabled}
            onChange={(e) => void patch({ fallGuard: { ...fg, enabled: e.target.checked } })}
          />
          Otomatik düşüş kurtarma
        </label>

        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-[10px] text-zinc-500">
            Min. hasar (HP)
            <input
              type="number"
              min={1}
              max={20}
              defaultValue={fg.minDamageHp}
              onBlur={(e) =>
                void patch({ fallGuard: { ...fg, minDamageHp: Math.max(1, Number(e.target.value) || 4) } })
              }
              className="mono w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-zinc-500">
            Ölümcül marj (can)
            <input
              type="number"
              min={0}
              max={10}
              defaultValue={fg.lethalHealthMargin}
              onBlur={(e) =>
                void patch({
                  fallGuard: { ...fg, lethalHealthMargin: Math.max(0, Number(e.target.value) || 2) }
                })
              }
              className="mono w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-zinc-500">
            MLG mesafe (blok)
            <input
              type="number"
              min={1}
              max={8}
              step={0.1}
              defaultValue={fg.mlgTriggerBlocks}
              onBlur={(e) =>
                void patch({
                  fallGuard: { ...fg, mlgTriggerBlocks: Math.max(1, Number(e.target.value) || 5.5) }
                })
              }
              className="mono w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
          </label>
        </div>

        <label className="mb-3 flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={fg.onlyWhenDangerous}
            onChange={(e) => void patch({ fallGuard: { ...fg, onlyWhenDangerous: e.target.checked } })}
          />
          Sadece tehlikeli/ölümcül düşüşte müdahale et
        </label>

        <div className="mb-3 rounded-lg border border-emerald-900/30 bg-emerald-950/10 px-2 py-2">
          <div className="mb-1.5 text-[10px] font-semibold tracking-wide text-emerald-400/90 uppercase">
            MLG malzeme geri al
          </div>
          <label className="mb-1.5 flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={fg.autoReclaim !== false}
              onChange={(e) => void patch({ fallGuard: { ...fg, autoReclaim: e.target.checked } })}
            />
            Otomatik geri al (iniş sonrası)
          </label>
          <div className="flex flex-wrap gap-3 text-xs text-zinc-400">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={fg.reclaimWater !== false}
                disabled={fg.autoReclaim === false}
                onChange={(e) => void patch({ fallGuard: { ...fg, reclaimWater: e.target.checked } })}
              />
              Su / powder snow <span className="text-emerald-500/80">(öncelikli)</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={fg.reclaimBoat !== false}
                disabled={fg.autoReclaim === false}
                onChange={(e) => void patch({ fallGuard: { ...fg, reclaimBoat: e.target.checked } })}
              />
              Tekne
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={fg.reclaimBlocks !== false}
                disabled={fg.autoReclaim === false}
                onChange={(e) => void patch({ fallGuard: { ...fg, reclaimBlocks: e.target.checked } })}
              />
              Blok yastık
            </label>
          </div>
          <p className="mt-1.5 text-[10px] text-zinc-600">
            Zor durumda (yanma, kaçış, çok yakın düşman) gecikir; su neredeyse her zaman alınır. Güvenli olunca tekrar
            dener.
          </p>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-2 py-2 text-[11px] leading-relaxed text-zinc-500">
          <p className="mb-1 text-zinc-400">Envanterde varsa sırayla değerlendirilir:</p>
          <ul className="list-inside list-disc space-y-0.5">
            <li>
              <b className="text-zinc-300">Su kovası</b> — klasik MLG; iniş sonrası boş kova ile kaynak geri alınır
            </li>
            <li>
              <b className="text-zinc-300">Tekne</b> — MLG + mümkünse tekneyi kırıp topla
            </li>
            <li>
              <b className="text-zinc-300">Saman / slime / cobweb…</b> — yumuşak iniş; güvenliyse kır-al
            </li>
          </ul>
          <p className="mt-2">
            Feather Falling hesaplanır. Pathfinder düşüşte kesilir. Malzeme yoksa log uyarısı (İ1, sohbet yok).
          </p>
          {fgLive?.inventoryOptions?.length ? (
            <p className="mono mt-2 text-emerald-500/80">Hazır: {fgLive.inventoryOptions.join(", ")}</p>
          ) : online ? (
            <p className="mt-2 text-zinc-600 italic">Şu an envanterde kurtarma malzemesi görünmüyor.</p>
          ) : null}
          {fgLive?.lastAction ? <p className="mono mt-1 text-zinc-600">son: {fgLive.lastAction}</p> : null}
        </div>
      </div>

      {/* Su / boğulma koruması */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Su koruması</div>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={wg.enabled}
            onChange={(e) => void patch({ waterGuard: { ...wg, enabled: e.target.checked } })}
          />
          Suda boğulmama + karaya çık (spawn dahil otomatik)
        </label>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={wg.seekLand}
            onChange={(e) => void patch({ waterGuard: { ...wg, seekLand: e.target.checked } })}
          />
          Yakındaki karaya yüz / yürü
        </label>
        <label className="mb-2 flex flex-col gap-1 text-[10px] text-zinc-500 max-w-xs">
          Oksijen eşiği (0–20) — altında acil yüzeye
          <input
            type="number"
            min={1}
            max={20}
            defaultValue={wg.surfaceOxygenBelow}
            onBlur={(e) =>
              void patch({
                waterGuard: { ...wg, surfaceOxygenBelow: Math.max(1, Math.min(20, Number(e.target.value) || 14)) }
              })
            }
            className="mono w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Kafa suda iken yukarı yüzer (space/jump). Yüzeyde nefes alır, boğulmaz. Derin suda veya düşük
          oksijende yakındaki karaya pathfinder ile çıkar. Okyanus spawn’da otomatik devreye girer.
        </p>
      </div>

      {/* Ateş / lav */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Ateş / lav koruması</div>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={hg.enabled}
            onChange={(e) => void patch({ hazardGuard: { ...hg, enabled: e.target.checked } })}
          />
          Otomatik ateş/lav kaçışı
        </label>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={hg.seekWater}
            onChange={(e) => void patch({ hazardGuard: { ...hg, seekWater: e.target.checked } })}
          />
          Yanınca suya koş
        </label>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={hg.useWaterBucket}
            onChange={(e) => void patch({ hazardGuard: { ...hg, useWaterBucket: e.target.checked } })}
          />
          Su kovası ile sön (varsa)
        </label>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Lavdaysa zıplayıp çıkar; yanıyorsa suya veya güvenli bloğa pathfinder ile kaçar. Magma/ateş
          bloğu üzerinde de devreye girer. Envanterde water_bucket varsa ayak altına döküp söndürmeyi dener.
        </p>
      </div>

      {/* Boş kova doldurma — MLG geri almadan bağımsız */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Boş kova doldur (opsiyonel)
        </div>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={scoop.enabled}
            onChange={(e) => void patch({ bucketScoop: { ...scoop, enabled: e.target.checked } })}
          />
          Yakındaki kaynaklardan boş kovayı doldur
        </label>
        <div className="mb-2 flex flex-wrap gap-4 text-xs text-zinc-400">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={scoop.scoopWater}
              disabled={!scoop.enabled}
              onChange={(e) => void patch({ bucketScoop: { ...scoop, scoopWater: e.target.checked } })}
            />
            Su
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={scoop.scoopLava}
              disabled={!scoop.enabled}
              onChange={(e) => void patch({ bucketScoop: { ...scoop, scoopLava: e.target.checked } })}
            />
            Lav
          </label>
        </div>
        <label className="mb-2 flex flex-col gap-1 text-[10px] text-zinc-500 max-w-[8rem]">
          Tarama yarıçapı
          <input
            type="number"
            min={1}
            max={6}
            defaultValue={scoop.radius}
            disabled={!scoop.enabled}
            onBlur={(e) =>
              void patch({
                bucketScoop: { ...scoop, radius: Math.max(1, Math.min(6, Number(e.target.value) || 3)) }
              })
            }
            className="mono w-16 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500 disabled:opacity-40"
          />
        </label>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          <b className="font-medium text-zinc-400">MLG su geri alma bundan ayrıdır</b> — bu kapalı olsa bile düşüşte
          dökülen MLG suyu (Yaşam → MLG malzeme geri al) alınır. Bu seçenek sadece boş gezerken kaynak doldurmak içindir.
        </p>
      </div>

      {/* Parkur */}
      <div className="rounded-lg border border-indigo-900/40 bg-indigo-950/15 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-indigo-300/90 uppercase">Gelişmiş parkur</div>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={mov.allowParkour !== false}
            onChange={(e) => void patchMove({ allowParkour: e.target.checked })}
          />
          Pathfinder parkour (2 blok boşluk + sprint)
        </label>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={mov.ladderParkour !== false}
            onChange={(e) => void patchMove({ ladderParkour: e.target.checked })}
          />
          Merdiven / vine parkuru
        </label>
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={mov.parkourSprint !== false}
            onChange={(e) => void patchMove({ parkourSprint: e.target.checked })}
          />
          Sprint jump (3–4 blok)
        </label>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-zinc-500 uppercase">Max gap</span>
          {([2, 3, 4] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => void patchMove({ parkourMaxGap: g })}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                (mov.parkourMaxGap ?? 3) === g
                  ? "bg-indigo-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              {g} blok
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Goto yolu yoksa 2–4 blok gap jump dener. Merdiven: yavaş tırman + güvenli çıkış (acele zıplama yok). Görev:{" "}
          <span className="mono text-zinc-400">parkour-goto</span>. 4 blok sunucuya göre kaçabilir.
        </p>

        <div className="mt-3 border-t border-zinc-800 pt-2">
          <div className="mb-1.5 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
            Uçurum güvenliği (deneysel — varsayılan kapalı)
          </div>
          <label className="mb-1.5 flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={mov.edgeSafety === true}
              onChange={(e) => void patchMove({ edgeSafety: e.target.checked })}
            />
            Kenar tarama (takibi bozabilir — kapalı önerilir)
          </label>
          <p className="text-[10px] leading-relaxed text-zinc-600">
            Kapalıyken pathfinder + parkour + MLG kullanılır. Açıkken yanlış pozitifle geri itme yapabiliyordu;
            şu an takip/goto döngüsünden çıkarıldı.
          </p>
        </div>
      </div>
    </div>
  );
}

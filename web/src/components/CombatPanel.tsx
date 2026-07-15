import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtPos } from "../lib/format";
import type { CombatRuntime, StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

const DEFEND_OPTIONS: { value: CombatRuntime["defendMode"]; label: string }[] = [
  { value: "off", label: "Kapalı" },
  { value: "mob", label: "Sadece mob" },
  { value: "player", label: "Sadece oyuncu" },
  { value: "all", label: "Hepsi" }
];

const MODE_TR: Record<CombatRuntime["mode"], string> = {
  idle: "Boşta",
  attacking: "Saldırıyor",
  defending: "Savunuyor",
  fleeing: "Kaçıyor"
};

/**
 * Faz 6 — Dövüş. Tasarım: InventoryPanel / TasksPanel
 * (zinc-800 kart, indigo birincil, red-900/60 durdur).
 */
export function CombatPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const applySnapshot = useAppStore((s) => s.applySnapshot);

  const [target, setTarget] = useState("");
  const [radius, setRadius] = useState("16");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!bot) return null;

  const combat = bot.combat ?? {
    defendMode: bot.config.combat.defendMode,
    fighting: false,
    mode: "idle" as const,
    activeTarget: null,
    lastDeath: null
  };
  const cfg = bot.config.combat;
  const online = bot.status === "online";

  const refresh = async () => applySnapshot(await api.get<StateSnapshot>("/api/state"));

  const patchCombat = async (patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/bots/${botId}`, { combat: patch });
      await refresh();
      toast("success", "Dövüş ayarları kaydedildi");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const act = async (action: Record<string, unknown>, okMsg?: string) => {
    try {
      await api.post(`/api/bots/${botId}/action`, action);
      if (okMsg) toast("info", okMsg);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const lootLeft = combat.lastDeath ? Math.max(0, combat.lastDeath.lootUntil - now) : 0;
  const lootSec = Math.ceil(lootLeft / 1000);

  const inputCls =
    "rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500";

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {!online && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          Bot çevrimdışı — ayarlar kaydedilir; dövüş görevleri bot online iken çalışır.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Durum</div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                combat.fighting ? "bg-red-950/60 text-red-300" : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {MODE_TR[combat.mode]}
            </span>
            {combat.activeTarget ? (
              <span className="text-zinc-300">
                Hedef: <b className="text-zinc-100">{combat.activeTarget}</b>
              </span>
            ) : (
              <span className="text-xs text-zinc-600 italic">Aktif hedef yok</span>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            RealismLayer her zaman açık: bak → menzil ≤ {cfg.reach} · görüş hattı · vuruş temposu · yumuşak dönüş · tepki{" "}
            {cfg.reactionMsMin}–{cfg.reactionMsMax} ms. Aimbot / duvar arkası vuruş yok (§9).
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => act({ type: "stop-combat" }, "Dövüş bırakıldı")}
              className="rounded-lg bg-red-900/60 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-800/60"
            >
              ■ Dövüşü Bırak
            </button>
            <button
              onClick={() => act({ type: "flee" }, "Kaçış kuyruğa alındı")}
              disabled={!online}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-amber-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              Kaç
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Savunma modu</div>
          <div className="flex flex-wrap gap-1.5">
            {DEFEND_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => void patchCombat({ defendMode: o.value })}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  cfg.defendMode === o.value
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Can ≤ {cfg.fleeAtHealth} olunca dövüş bırakılır (İ6). Kovalama: {cfg.chaseDistance} blok.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Hedefli saldırı</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && target && act({ type: "attack", player: target }, `Saldırı: ${target}`)}
            placeholder="Oyuncu adı"
            className={`w-44 ${inputCls}`}
          />
          <button
            onClick={() => act({ type: "attack", player: target }, `Saldırı: ${target}`)}
            disabled={!online || !target.trim()}
            className="rounded-lg bg-red-900/60 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-800/60 disabled:opacity-40"
          >
            Saldır
          </button>
          <input
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            className={`mono w-16 ${inputCls}`}
            title="Mob temizleme yarıçapı"
          />
          <button
            onClick={() => act({ type: "clear-mobs", radius: Number(radius) || 16 }, "Mob temizliği başlatıldı")}
            disabled={!online}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
          >
            Mob Temizle
          </button>
        </div>
        <p className="mono mt-2 text-[10px] text-zinc-600">komut: attack isim · mobtemizle [yarıçap] · kac · loot · stop</p>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Gerçekçilik ayarları</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumField label="Menzil (blok)" value={cfg.reach} step={0.1} min={1} max={4} onCommit={(v) => void patchCombat({ reach: v })} />
          <NumField label="CPS tavanı (1.8)" value={cfg.cpsCap} min={1} max={15} onCommit={(v) => void patchCombat({ cpsCap: v })} />
          <NumField label="Tepki min (ms)" value={cfg.reactionMsMin} min={0} max={1000} onCommit={(v) => void patchCombat({ reactionMsMin: v })} />
          <NumField label="Tepki max (ms)" value={cfg.reactionMsMax} min={0} max={1500} onCommit={(v) => void patchCombat({ reactionMsMax: v })} />
          <NumField label="Dönüş °/tick" value={cfg.turnSpeedDegPerTick} min={5} max={90} onCommit={(v) => void patchCombat({ turnSpeedDegPerTick: v })} />
          <NumField label="Kaçış can eşiği" value={cfg.fleeAtHealth} min={1} max={20} onCommit={(v) => void patchCombat({ fleeAtHealth: v })} />
          <NumField label="Kovalama mesafesi" value={cfg.chaseDistance} min={4} max={64} onCommit={(v) => void patchCombat({ chaseDistance: v })} />
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={cfg.jumpCrit} onChange={(e) => void patchCombat({ jumpCrit: e.target.checked })} />
            Zıplayarak kritik (opsiyonel)
          </label>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Ölüm &amp; loot</div>
        {combat.lastDeath ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="mono text-zinc-300">
              📍 {fmtPos(combat.lastDeath)} <span className="text-zinc-600">({combat.lastDeath.dimension})</span>
            </span>
            <span className={`text-xs ${lootLeft > 0 ? "text-amber-300" : "text-zinc-600"}`}>
              {lootLeft > 0
                ? `Loot süresi: ${Math.floor(lootSec / 60)}:${String(lootSec % 60).padStart(2, "0")}`
                : "Süre dolmuş olabilir"}
            </span>
            <button
              onClick={() => act({ type: "loot-death" }, "Ölüm noktasına gidiliyor")}
              disabled={!online || lootLeft <= 0}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Eşyaları Geri Topla
            </button>
          </div>
        ) : (
          <p className="text-xs text-zinc-600 italic">Henüz kayıtlı ölüm yok. Ölünce otomatik waypoint: ölüm-&lt;bot&gt;</p>
        )}
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      <span>{label}</span>
      <input
        type="number"
        value={local}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local);
          if (!Number.isFinite(n)) {
            setLocal(String(value));
            return;
          }
          const clamped = Math.min(max ?? n, Math.max(min ?? n, n));
          setLocal(String(clamped));
          if (clamped !== value) onCommit(clamped);
        }}
        className="mono rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
      />
    </label>
  );
}

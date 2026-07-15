import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { fmtPos } from "../lib/format";
import type { CombatRuntime, StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

const MODE_KEYS: Record<CombatRuntime["mode"], string> = {
  idle: "combat.modes.idle",
  attacking: "combat.modes.attacking",
  defending: "combat.modes.defending",
  fleeing: "combat.modes.fleeing",
  protecting: "combat.modes.protecting"
};

/**
 * Faz 6 — Dövüş paneli.
 * Ayarlar anlık uygulanır (ayrı “Kaydet” yok).
 * Öz savunma = boşta zombie vb.; Eşlik = yakındaki oyuncular → Koru.
 */
export function CombatPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const { t } = useI18n();

  const DEFEND_OPTIONS: { value: CombatRuntime["defendMode"]; label: string; hint: string }[] = [
    { value: "off", label: t("combat.defendOff"), hint: t("combat.defendOff") },
    { value: "mob", label: t("combat.defendMob"), hint: "Zombie, skeleton…" },
    { value: "player", label: t("combat.defendPlayer"), hint: t("combat.cleavePlayers") },
    { value: "all", label: t("combat.defendAll"), hint: "Mob + player" }
  ];

  const [target, setTarget] = useState("");
  const [radius, setRadius] = useState("16");
  const [now, setNow] = useState(Date.now());
  const [whitelistText, setWhitelistText] = useState("");
  const wlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const combat = bot?.combat;
  const ps = combat?.companion?.protectSettings;
  const companion = combat?.companion;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!ps) return;
    setWhitelistText((ps.whitelist ?? []).join(", "));
  }, [(ps?.whitelist ?? []).join(",")]);

  useEffect(() => {
    return () => {
      if (wlTimer.current) clearTimeout(wlTimer.current);
    };
  }, []);

  if (!bot) return null;

  const c: CombatRuntime = combat ?? {
    defendMode: bot.config.combat.defendMode,
    fighting: false,
    mode: "idle",
    activeTarget: null,
    lastDeath: null,
    companion: {
      followPlayer: null,
      followDistance: 3,
      attackPlayer: null,
      protectPlayers: [],
      protectPlayer: null,
      protectSettings: {
        range: 10,
        protectAggro: "threats",
        retaliateMobs: true,
        retaliatePlayers: true,
        whitelist: []
      }
    }
  };
  const cfg = bot.config.combat;
  const online = bot.status === "online";
  const defendRange = cfg.defendRange ?? 12;
  const wards = c.companion?.protectPlayers?.length
    ? c.companion.protectPlayers
    : c.companion?.protectPlayer
      ? [c.companion.protectPlayer]
      : [];
  const escortPs = c.companion?.protectSettings ?? {
    range: 10,
    protectAggro: "threats" as const,
    retaliateMobs: true,
    retaliatePlayers: true,
    whitelist: [] as string[]
  };
  const followDist = c.companion?.followDistance ?? 3;
  const aggro = escortPs.protectAggro === "non_whitelist" ? "non_whitelist" : "threats";

  const refresh = async () => applySnapshot(await api.get<StateSnapshot>("/api/state"));

  /** config.combat patch — anlık, toast yok (hata hariç) */
  const patchCombat = async (patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/bots/${botId}`, { combat: patch });
      await refresh();
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

  /** Eşlik ayarları — anlık protect-settings (toast yok) */
  const applyProtect = (patch: Record<string, unknown>) => {
    void act({
      type: "protect-settings",
      range: escortPs.range,
      protectAggro: aggro,
      retaliateMobs: escortPs.retaliateMobs,
      retaliatePlayers: escortPs.retaliatePlayers,
      whitelist: escortPs.whitelist ?? [],
      followDistance: followDist,
      ...patch
    });
  };

  const scheduleWhitelist = (text: string) => {
    setWhitelistText(text);
    if (wlTimer.current) clearTimeout(wlTimer.current);
    wlTimer.current = setTimeout(() => {
      const wl = text
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      applyProtect({ whitelist: wl });
    }, 450);
  };

  const lootLeft = c.lastDeath ? Math.max(0, c.lastDeath.lootUntil - now) : 0;
  const lootSec = Math.ceil(lootLeft / 1000);

  const inputCls =
    "rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500";
  const chip = (on: boolean, accent = "indigo") =>
    on
      ? accent === "amber"
        ? "bg-amber-700 text-white"
        : accent === "emerald"
          ? "bg-emerald-600 text-white"
          : "bg-indigo-600 text-white"
      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200";

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {!online && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {t("combat.offlineHint")}
        </div>
      )}

      {/* ── Durum ── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("combat.status")}</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => act({ type: "stop-combat" }, t("combat.combatLeft"))}
              className="rounded-lg bg-red-900/60 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-800/60"
            >
              {t("combat.leaveCombat")}
            </button>
            <button
              type="button"
              onClick={() => act({ type: "flee" }, t("combat.flee"))}
              disabled={!online}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-amber-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              {t("combat.flee")}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              c.fighting ? "bg-red-950/60 text-red-300" : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {t(MODE_KEYS[c.mode])}
          </span>
          {c.activeTarget ? (
            <span className="text-zinc-300">
              {t("combat.target")}: <b className="text-zinc-100">{c.activeTarget}</b>
            </span>
          ) : (
            <span className="text-xs text-zinc-600 italic">{t("combat.noTarget")}</span>
          )}
          <span className="text-[10px] text-zinc-600">
            {t("combat.selfDefense")}:{" "}
            <span className={cfg.defendMode === "off" ? "text-zinc-500" : "text-emerald-400/90"}>
              {DEFEND_OPTIONS.find((o) => o.value === cfg.defendMode)?.label ?? cfg.defendMode}
            </span>
            {cfg.cleaveNearby ? (
              <>
                {" · "}
                {t("combat.cleaveTitle")}:{" "}
                <span className="text-rose-300/90">
                  {[
                    cfg.cleaveMobs !== false ? t("combat.cleaveMobs") : null,
                    cfg.cleavePlayers !== false ? t("combat.cleavePlayers") : null
                  ]
                    .filter(Boolean)
                    .join("+") || "—"}
                </span>
              </>
            ) : null}
            {wards.length > 0 && (
              <>
                {" · "}
                {t("combat.escortLabel")} <span className="text-indigo-300">{wards.join(", ")}</span>
              </>
            )}
          </span>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Öz savunma (boşta) ── */}
        <section className="rounded-lg border border-emerald-900/35 bg-emerald-950/10 p-3">
          <div className="mb-1 text-xs font-semibold tracking-wide text-emerald-300/90 uppercase">
            {t("combat.selfDefense")}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">{t("combat.selfDefenseHint")}</p>

          <div className="mb-1 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">{t("combat.targetType")}</div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {DEFEND_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                title={o.hint}
                onClick={() => void patchCombat({ defendMode: o.value })}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${chip(
                  cfg.defendMode === o.value,
                  o.value === "off" ? "indigo" : "emerald"
                )}`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <NumField
              label={t("combat.scanRange")}
              value={defendRange}
              min={4}
              max={32}
              onCommit={(v) => void patchCombat({ defendRange: v })}
            />
            <NumField
              label={t("combat.fleeHealth")}
              value={cfg.fleeAtHealth}
              min={1}
              max={20}
              onCommit={(v) => void patchCombat({ fleeAtHealth: v })}
            />
            <NumField
              label={t("combat.chaseDistance")}
              value={cfg.chaseDistance}
              min={4}
              max={64}
              onCommit={(v) => void patchCombat({ chaseDistance: v })}
            />
          </div>
          <p className="mt-2 text-[10px] text-zinc-600">
            {t("combat.selfDefenseExample", { health: cfg.fleeAtHealth, range: defendRange })}
          </p>
        </section>

        {/* ── Ara vuruş (cleave) ── */}
        <section className="rounded-lg border border-rose-900/40 bg-rose-950/15 p-3 lg:col-span-2">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <div className="text-xs font-semibold tracking-wide text-rose-300/90 uppercase">
              {t("combat.cleaveTitle")}
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                cfg.cleaveNearby ? "bg-rose-900/50 text-rose-200" : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {cfg.cleaveNearby ? t("combat.cleaveOn") : t("combat.cleaveOff")}
            </span>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">{t("combat.cleaveHint")}</p>

          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => void patchCombat({ cleaveNearby: !cfg.cleaveNearby })}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${chip(
                Boolean(cfg.cleaveNearby),
                "amber"
              )}`}
            >
              {cfg.cleaveNearby ? t("combat.cleaveToggleOn") : t("combat.cleaveToggleOff")}
            </button>
            <button
              type="button"
              disabled={!cfg.cleaveNearby}
              onClick={() => void patchCombat({ cleaveMobs: !(cfg.cleaveMobs !== false) })}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 ${chip(
                cfg.cleaveNearby !== false && cfg.cleaveMobs !== false,
                "emerald"
              )}`}
            >
              {t("combat.cleaveMobs")}
            </button>
            <button
              type="button"
              disabled={!cfg.cleaveNearby}
              onClick={() => void patchCombat({ cleavePlayers: !(cfg.cleavePlayers !== false) })}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 ${chip(
                cfg.cleaveNearby !== false && cfg.cleavePlayers !== false
              )}`}
            >
              {t("combat.cleavePlayers")}
            </button>
          </div>

          <div className="max-w-xs">
            <NumField
              label={t("combat.cleaveRange")}
              value={cfg.cleaveRange ?? cfg.reach ?? 3}
              min={1.5}
              max={4.5}
              step={0.1}
              onCommit={(v) => void patchCombat({ cleaveRange: v })}
            />
          </div>
          <p className="mt-2 text-[10px] text-zinc-600">{t("combat.cleaveExample")}</p>
        </section>

        {/* ── Eşlik koruması ── */}
        <section className="rounded-lg border border-indigo-900/40 bg-indigo-950/15 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <div className="text-xs font-semibold tracking-wide text-indigo-300/90 uppercase">{t("combat.escort")}</div>
            {wards.length > 0 ? (
              <span className="rounded-full bg-indigo-950/60 px-2 py-0.5 text-[10px] text-indigo-200">
                {wards.join(", ")}
                {c.companion?.followPlayer ? t("combat.escortMain", { name: c.companion.followPlayer }) : ""}
              </span>
            ) : (
              <span className="text-[10px] text-zinc-600 italic">{t("combat.escortNone")}</span>
            )}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">{t("combat.escortHint")}</p>

          <div className="mb-1 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">{t("combat.attackModeLabel")}</div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => applyProtect({ protectAggro: "threats" })}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${chip(aggro === "threats")}`}
            >
              {t("combat.aggroThreatsOnly")}
            </button>
            <button
              type="button"
              onClick={() => applyProtect({ protectAggro: "non_whitelist" })}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${chip(aggro === "non_whitelist", "amber")}`}
            >
              {t("combat.aggroNonWhitelist")}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <NumField
              label={t("combat.protectRange")}
              value={escortPs.range ?? 10}
              min={4}
              max={32}
              onCommit={(v) => applyProtect({ range: v })}
            />
            <NumField
              label={t("combat.mainFollowDistance")}
              value={followDist}
              min={1}
              max={16}
              onCommit={(v) => applyProtect({ followDistance: v })}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={escortPs.retaliateMobs ?? true}
                onChange={(e) => applyProtect({ retaliateMobs: e.target.checked })}
              />
              {t("combat.retaliateMob")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={escortPs.retaliatePlayers ?? true}
                onChange={(e) => applyProtect({ retaliatePlayers: e.target.checked })}
              />
              {t("combat.retaliatePlayer")}
            </label>
          </div>

          <label className="mt-3 flex flex-col gap-1 text-xs text-zinc-400">
            <span>
              {t("combat.whitelistLabel")} <span className="font-normal text-zinc-600">{t("combat.whitelistHint")}</span>
            </span>
            <input
              value={whitelistText}
              onChange={(e) => scheduleWhitelist(e.target.value)}
              onBlur={() => {
                if (wlTimer.current) {
                  clearTimeout(wlTimer.current);
                  wlTimer.current = null;
                }
                const wl = whitelistText
                  .split(/[,;\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                applyProtect({ whitelist: wl });
              }}
              placeholder={t("combat.whitelistPlaceholder")}
              className={inputCls}
            />
          </label>
        </section>
      </div>

      {/* ── Hedefli saldırı ── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("combat.targetedAttack")}</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && target && act({ type: "attack", player: target }, t("combat.attackToast", { name: target }))}
            placeholder={t("common.playerNamePlaceholder")}
            className={`w-44 ${inputCls}`}
          />
          <button
            type="button"
            onClick={() => act({ type: "attack", player: target }, t("combat.attackToast", { name: target }))}
            disabled={!online || !target.trim()}
            className="rounded-lg bg-red-900/60 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-800/60 disabled:opacity-40"
          >
            {t("combat.attackButton")}
          </button>
          <input
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            className={`mono w-16 ${inputCls}`}
            title={t("combat.clearMobsRadiusTitle")}
          />
          <button
            type="button"
            onClick={() => act({ type: "clear-mobs", radius: Number(radius) || 16 }, t("combat.clearMobsToast"))}
            disabled={!online}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
          >
            {t("combat.clearMobsButton")}
          </button>
        </div>
        <p className="mono mt-2 text-[10px] text-zinc-600">{t("combat.commandsHint")}</p>
      </section>

      {/* ── Gerçekçilik ── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("combat.realismTitle")}</div>
        <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
          {t("combat.realismHint", { reach: cfg.reach, reactionMin: cfg.reactionMsMin, reactionMax: cfg.reactionMsMax })}
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumField label={t("combat.rangeLabel")} value={cfg.reach} step={0.1} min={1} max={4} onCommit={(v) => void patchCombat({ reach: v })} />
          <NumField label={t("combat.cpsCapLabel")} value={cfg.cpsCap} min={1} max={15} onCommit={(v) => void patchCombat({ cpsCap: v })} />
          <NumField label={t("combat.reactionMinLabel")} value={cfg.reactionMsMin} min={0} max={1000} onCommit={(v) => void patchCombat({ reactionMsMin: v })} />
          <NumField label={t("combat.reactionMaxLabel")} value={cfg.reactionMsMax} min={0} max={1500} onCommit={(v) => void patchCombat({ reactionMsMax: v })} />
          <NumField label={t("combat.turnSpeedLabel")} value={cfg.turnSpeedDegPerTick} min={5} max={90} onCommit={(v) => void patchCombat({ turnSpeedDegPerTick: v })} />
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={cfg.jumpCrit} onChange={(e) => void patchCombat({ jumpCrit: e.target.checked })} />
            {t("combat.jumpCritLabel")}
          </label>
        </div>
      </section>

      {/* ── Ölüm & loot ── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("combat.deathLootTitle")}</div>
        {c.lastDeath ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="mono flex items-center gap-1 text-zinc-300">
              <MapPin className="h-3.5 w-3.5 shrink-0" /> {fmtPos(c.lastDeath)}{" "}
              <span className="text-zinc-600">({c.lastDeath.dimension})</span>
            </span>
            <span className={`text-xs ${lootLeft > 0 ? "text-amber-300" : "text-zinc-600"}`}>
              {lootLeft > 0
                ? t("combat.lootCountdown", { time: `${Math.floor(lootSec / 60)}:${String(lootSec % 60).padStart(2, "0")}` })
                : t("combat.lootExpired")}
            </span>
            <button
              type="button"
              onClick={() => act({ type: "loot-death" }, t("combat.gotoDeathToast"))}
              disabled={!online || lootLeft <= 0}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              {t("combat.recoverItemsButton")}
            </button>
          </div>
        ) : (
          <p className="text-xs text-zinc-600 italic">{t("combat.noDeathRecorded")}</p>
        )}
      </section>
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

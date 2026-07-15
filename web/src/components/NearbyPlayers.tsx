import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { EV } from "../lib/events";
import { socket } from "../lib/socket";
import type { CompanionState } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

interface NearbyPlayer {
  username: string;
  distance: number | null;
  hasEntity: boolean;
  x?: number;
  y?: number;
  z?: number;
}

const defaultCompanion = (): CompanionState => ({
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
});

const btnBase = "rounded-lg px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40";
const btnIdle = `${btnBase} bg-zinc-800 text-zinc-300 hover:bg-zinc-700`;
const btnFollowOn = `${btnBase} bg-emerald-600 text-white ring-1 ring-emerald-400/50`;
const btnAttackOn = `${btnBase} bg-red-600 text-white ring-1 ring-red-400/50`;
const btnProtectOn = `${btnBase} bg-indigo-600 text-white ring-1 ring-indigo-400/50`;
const btnMainOn = `${btnBase} bg-amber-600 text-white ring-1 ring-amber-400/50`;

function protectList(c: CompanionState): string[] {
  if (c.protectPlayers?.length) return c.protectPlayers;
  if (c.protectPlayer) return [c.protectPlayer];
  return [];
}

export function NearbyPlayers({ botId }: { botId: string }) {
  const { t } = useI18n();
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const [players, setPlayers] = useState<NearbyPlayer[]>([]);
  const [radius, setRadius] = useState(48);
  const [followDist, setFollowDist] = useState(3);

  const companion = bot?.combat?.companion ?? defaultCompanion();
  const wards = protectList(companion);

  useEffect(() => {
    setFollowDist(companion.followDistance || 3);
  }, [companion.followDistance]);

  useEffect(() => {
    const onNearby = (p: { botId: string; players: NearbyPlayer[] }) => {
      if (p.botId === botId) setPlayers(p.players ?? []);
    };
    socket.on(EV.BOT_NEARBY, onNearby);
    return () => {
      socket.off(EV.BOT_NEARBY, onNearby);
    };
  }, [botId]);

  useEffect(() => {
    if (!bot || bot.status !== "online") {
      setPlayers([]);
      return;
    }
    let cancelled = false;
    const pull = () => {
      api
        .get<{ players: NearbyPlayer[] }>(`/api/bots/${botId}/nearby?radius=${radius}`)
        .then((r) => {
          if (!cancelled) setPlayers(r.players ?? []);
        })
        .catch(() => {});
    };
    pull();
    const tmr = setInterval(pull, 2000);
    return () => {
      cancelled = true;
      clearInterval(tmr);
    };
  }, [botId, bot?.status, radius]);

  const act = async (action: Record<string, unknown>, msg?: string) => {
    try {
      await api.post(`/api/bots/${botId}/action`, action);
      if (msg) toast("info", msg);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const isFollow = (name: string) => companion.followPlayer?.toLowerCase() === name.toLowerCase();
  const isAttack = (name: string) => companion.attackPlayer?.toLowerCase() === name.toLowerCase();
  const isProtect = (name: string) => wards.some((w) => w.toLowerCase() === name.toLowerCase());
  const isMain = (name: string) => isFollow(name) && isProtect(name);

  const toggleFollow = (name: string) => {
    const on = !isFollow(name);
    void act(
      { type: "social-follow", player: name, enabled: on, distance: followDist },
      on
        ? t("nearby.followMainToast", { name, dist: followDist })
        : t("nearby.followOffToast", { name })
    );
  };

  const toggleAttack = (name: string) => {
    if (isProtect(name)) {
      toast("error", t("nearby.attackProtectedError"));
      return;
    }
    const on = !isAttack(name);
    void act(
      { type: "social-attack", player: name, enabled: on },
      on ? t("nearby.attackToast", { name }) : t("nearby.attackOffToast", { name })
    );
  };

  const toggleProtect = (name: string) => {
    const on = !isProtect(name);
    const setAsMain = on && wards.length === 0;
    void act(
      {
        type: "social-protect",
        player: name,
        enabled: on,
        followDistance: followDist,
        setAsMain
      },
      on
        ? setAsMain
          ? t("nearby.protectMainToast", { name })
          : t("nearby.protectAddToast", { name })
        : t("nearby.protectRemoveToast", { name })
    );
  };

  const setAsMainFollow = (name: string) => {
    void act(
      { type: "social-follow", player: name, enabled: true, distance: followDist },
      t("nearby.setMainToast", { name })
    );
  };

  if (!bot) return null;
  const online = bot.status === "online";
  const inRange = players.filter((p) => p.hasEntity && p.distance != null && p.distance <= radius);
  const tabOnly = players.filter((p) => !p.hasEntity);

  const activeLine =
    companion.followPlayer || companion.attackPlayer || wards.length
      ? [
          wards.length ? t("nearby.activeProtect", { list: wards.join(", ") }) : null,
          companion.followPlayer
            ? t("nearby.activeMain", {
                name: companion.followPlayer,
                dist: companion.followDistance
              })
            : null,
          companion.attackPlayer ? t("nearby.activeAttack", { name: companion.attackPlayer }) : null
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          {t("nearby.title")}
        </span>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
          {t("nearby.inRangeCount", { n: inRange.length })}
          {tabOnly.length ? ` · ${t("nearby.tabCount", { n: tabOnly.length })}` : ""}
        </span>
        {activeLine && (
          <span className="rounded-full bg-indigo-950/50 px-2 py-0.5 text-[10px] text-indigo-300">{activeLine}</span>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-zinc-500">
          {t("nearby.listRadius")}
          <input
            type="number"
            min={4}
            max={128}
            value={radius}
            onChange={(e) => setRadius(Math.max(4, Math.min(128, Number(e.target.value) || 48)))}
            className="mono w-14 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
          {t("nearby.followDistance")}
          <input
            type="number"
            min={1}
            max={16}
            value={followDist}
            onChange={(e) => setFollowDist(Math.max(1, Math.min(16, Number(e.target.value) || 3)))}
            className="mono w-12 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200 outline-none focus:border-indigo-500"
            title={t("nearby.followDistanceTitle")}
          />
        </label>
      </div>

      {wards.length > 0 && (
        <p className="mb-2 text-[10px] leading-relaxed text-zinc-500">
          {t("nearby.protectLine")} <span className="text-indigo-300">{wards.join(", ")}</span>
          {companion.followPlayer ? (
            <>
              {" "}
              · {t("nearby.mainLine")} <span className="text-emerald-300">{companion.followPlayer}</span>
            </>
          ) : null}
          {" · "}
          {t("nearby.settingsHint")}{" "}
          <span className="text-amber-300/90">{t("nearby.settingsLink")}</span>
        </p>
      )}

      {!online && <p className="text-xs text-zinc-600 italic">{t("nearby.offlineHint")}</p>}

      {online && inRange.length === 0 && tabOnly.length === 0 && (
        <p className="text-xs text-zinc-600 italic">{t("nearby.emptyInRange")}</p>
      )}

      <div className="max-h-64 space-y-1.5 overflow-y-auto">
        {inRange.map((p) => {
          const fOn = isFollow(p.username);
          const aOn = isAttack(p.username);
          const pOn = isProtect(p.username);
          const main = isMain(p.username);
          return (
            <div
              key={p.username}
              className={`flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 ${
                pOn ? "border-indigo-800/60 bg-indigo-950/20" : "border-zinc-800 bg-zinc-950/40"
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">
                {p.username}
                {main && (
                  <span className="ml-1 text-[10px] font-normal text-amber-400">{t("nearby.mainBadge")}</span>
                )}
                {pOn && !main && (
                  <span className="ml-1 text-[10px] font-normal text-indigo-400">{t("nearby.protectBadge")}</span>
                )}
              </span>
              <span className="mono text-[10px] text-zinc-500">{p.distance?.toFixed(1)} m</span>
              <button
                type="button"
                disabled={!online}
                onClick={() => toggleFollow(p.username)}
                className={fOn ? btnFollowOn : btnIdle}
              >
                {fOn ? t("nearby.followOn") : t("nearby.follow")}
              </button>
              {pOn && !fOn && (
                <button
                  type="button"
                  disabled={!online}
                  onClick={() => setAsMainFollow(p.username)}
                  className={btnMainOn}
                >
                  {t("nearby.setMain")}
                </button>
              )}
              <button
                type="button"
                disabled={!online}
                onClick={() =>
                  act(
                    { type: "goto-player", player: p.username },
                    t("nearby.goToToast", { name: p.username })
                  )
                }
                className={btnIdle}
              >
                {t("nearby.goTo")}
              </button>
              <button
                type="button"
                disabled={!online || pOn}
                onClick={() => toggleAttack(p.username)}
                className={aOn ? btnAttackOn : btnIdle}
              >
                {aOn ? t("nearby.attackOn") : t("nearby.attack")}
              </button>
              <button
                type="button"
                disabled={!online}
                onClick={() => toggleProtect(p.username)}
                className={pOn ? btnProtectOn : btnIdle}
                title={t("nearby.protectTitle")}
              >
                {pOn ? t("nearby.protectOn") : t("nearby.protect")}
              </button>
            </div>
          );
        })}

        {tabOnly.map((p) => (
          <div
            key={`tab-${p.username}`}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-zinc-800 px-2 py-1.5 opacity-80"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-zinc-400">{p.username}</span>
            <span className="text-[10px] text-zinc-600">{t("nearby.tabNoPos")}</span>
            <button
              type="button"
              disabled={!online}
              onClick={() => toggleFollow(p.username)}
              className={isFollow(p.username) ? btnFollowOn : btnIdle}
            >
              {isFollow(p.username) ? t("nearby.followWaitOn") : t("nearby.followWait")}
            </button>
            <button
              type="button"
              disabled={!online}
              onClick={() => toggleProtect(p.username)}
              className={isProtect(p.username) ? btnProtectOn : btnIdle}
            >
              {isProtect(p.username) ? t("nearby.protectOn") : t("nearby.protect")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

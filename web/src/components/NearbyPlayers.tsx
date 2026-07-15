import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { socket } from "../lib/socket";
import { EV } from "../lib/events";
import { useAppStore } from "../stores/useAppStore";

interface NearbyPlayer {
  username: string;
  distance: number | null;
  hasEntity: boolean;
  x?: number;
  y?: number;
  z?: number;
}

/** Bot detay — menzildeki oyuncular; tıkla takip / yanına git / saldır / fısılda. */
export function NearbyPlayers({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const [players, setPlayers] = useState<NearbyPlayer[]>([]);
  const [radius, setRadius] = useState(48);

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
    const t = setInterval(pull, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
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

  if (!bot) return null;
  const online = bot.status === "online";
  const inRange = players.filter((p) => p.hasEntity && p.distance != null && p.distance <= radius);
  const tabOnly = players.filter((p) => !p.hasEntity);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Yakındaki oyuncular</span>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
          {inRange.length} menzilde{tabOnly.length ? ` · ${tabOnly.length} tab (konum yok)` : ""}
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-zinc-500">
          Menzil
          <input
            type="number"
            min={4}
            max={128}
            value={radius}
            onChange={(e) => setRadius(Math.max(4, Math.min(128, Number(e.target.value) || 48)))}
            className="mono w-14 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200 outline-none focus:border-indigo-500"
          />
        </label>
      </div>

      {!online && (
        <p className="text-xs text-zinc-600 italic">Bot online olunca yakındaki oyuncular burada listelenir.</p>
      )}

      {online && inRange.length === 0 && tabOnly.length === 0 && (
        <p className="text-xs text-zinc-600 italic">
          Menzilde oyuncu yok (veya sunucu entity yayınlamıyor — flying-squid / uzak mesafe).
        </p>
      )}

      <div className="max-h-40 space-y-1 overflow-y-auto">
        {inRange.map((p) => (
          <div
            key={p.username}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{p.username}</span>
            <span className="mono text-[10px] text-zinc-500">{p.distance?.toFixed(1)} m</span>
            <button
              type="button"
              onClick={() => act({ type: "follow", player: p.username, distance: 3 }, `Takip: ${p.username}`)}
              className="rounded-lg bg-zinc-800 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-zinc-700"
            >
              Takip
            </button>
            <button
              type="button"
              onClick={() => act({ type: "goto-player", player: p.username }, `Yanına: ${p.username}`)}
              className="rounded-lg bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700"
            >
              Yanına
            </button>
            <button
              type="button"
              onClick={() => act({ type: "attack", player: p.username }, `Saldır: ${p.username}`)}
              className="rounded-lg bg-red-900/60 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-800/60"
            >
              Saldır
            </button>
            <button
              type="button"
              onClick={() => act({ type: "chat", text: `/msg ${p.username} ` }, `Fısıltı hazır: ${p.username}`)}
              className="rounded-lg bg-zinc-800 px-2 py-0.5 text-[11px] text-purple-300 hover:bg-zinc-700"
              title="Sohbete /msg yazar (rate limiter)"
            >
              Msg
            </button>
          </div>
        ))}
        {tabOnly.map((p) => (
          <div
            key={`tab-${p.username}`}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-zinc-800 px-2 py-1.5 opacity-80"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-zinc-400">{p.username}</span>
            <span className="text-[10px] text-zinc-600">tab · konum yok</span>
            <button
              type="button"
              onClick={() => act({ type: "follow", player: p.username }, `Takip bekle: ${p.username}`)}
              className="rounded-lg bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-700"
            >
              Takip (bekle)
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

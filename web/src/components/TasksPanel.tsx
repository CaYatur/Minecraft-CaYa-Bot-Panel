import { useState } from "react";
import { api } from "../lib/api";
import { fmtPos } from "../lib/format";
import type { TaskSummary, Waypoint } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

const CMD_HELP = "goto x y z · follow isim [mesafe] · yanina isim · wp isim · wpkaydet isim · say metin · stop";

// zustand kuralı: seçici içinde yeni dizi/obje ÜRETME (sonsuz render döngüsü yapar).
// Boş varsayılanlar modül sabiti olarak dışarıda tutulur.
const EMPTY_WAYPOINTS: Waypoint[] = [];

export function TasksPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const waypoints = useAppStore((s) => (bot ? s.waypoints[bot.config.serverId] : undefined)) ?? EMPTY_WAYPOINTS;
  const toast = useAppStore((s) => s.toast);

  const [cmd, setCmd] = useState("");
  const [gx, setGx] = useState("");
  const [gy, setGy] = useState("");
  const [gz, setGz] = useState("");
  const [player, setPlayer] = useState("");
  const [wpName, setWpName] = useState("");

  if (!bot) return null;
  const tasks = bot.tasks ?? { current: null, queue: [] };

  const act = async (action: Record<string, unknown>, okMsg?: string) => {
    try {
      await api.post(`/api/bots/${botId}/action`, action);
      if (okMsg) toast("info", okMsg);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const saveWaypointHere = async (name: string) => {
    try {
      await api.post(`/api/bots/${botId}/waypoint-here`, { name });
      toast("success", `Waypoint kaydedildi: ${name}`);
      setWpName("");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const runCommand = async () => {
    const parts = cmd.trim().split(/\s+/);
    const verb = (parts[0] ?? "").toLowerCase();
    if (!verb) return;
    setCmd("");
    try {
      if ((verb === "goto" || verb === "git") && parts.length >= 4) {
        await act({ type: "goto", x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]) });
      } else if ((verb === "follow" || verb === "takip") && parts[1]) {
        await act({ type: "follow", player: parts[1], distance: parts[2] ? Number(parts[2]) : 3 });
      } else if ((verb === "yanina" || verb === "gotoplayer") && parts[1]) {
        await act({ type: "goto-player", player: parts[1] });
      } else if (verb === "wp" && parts[1]) {
        const wp = waypoints.find((w) => w.name.toLowerCase() === parts[1]!.toLowerCase());
        if (!wp) throw new Error(`Waypoint yok: ${parts[1]}`);
        await act({ type: "goto-waypoint", waypointId: wp.id });
      } else if (verb === "wpkaydet" && parts[1]) {
        await saveWaypointHere(parts[1]!);
      } else if (verb === "say" || verb === "de") {
        await act({ type: "chat", text: parts.slice(1).join(" ") });
      } else if (verb === "stop" || verb === "dur") {
        await act({ type: "stop" }, "Hareket durduruldu");
      } else {
        throw new Error(`Anlaşılmadı. Komutlar: ${CMD_HELP}`);
      }
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const cancelTask = async (t: TaskSummary) => {
    try {
      await api.post(`/api/bots/${botId}/tasks/${t.id}/cancel`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const gotoWp = (wp: Waypoint) => act({ type: "goto-waypoint", waypointId: wp.id }, `${wp.name} hedefine gidiliyor`);
  const delWp = async (wp: Waypoint) => {
    try {
      await api.del(`/api/waypoints/${wp.id}`);
      toast("info", `Waypoint silindi: ${wp.name}`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {/* komut satırı */}
      <div>
        <div className="flex gap-2">
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runCommand()}
            placeholder="Komut: goto 100 64 -200"
            className="mono flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
          <button
            onClick={runCommand}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Çalıştır
          </button>
          <button
            onClick={() => act({ type: "stop" }, "Hareket durduruldu")}
            className="rounded-lg bg-red-900/60 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-800/60"
          >
            ■ Durdur
          </button>
        </div>
        <p className="mono mt-1 text-[10px] text-zinc-600">{CMD_HELP}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* hızlı hareket */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Hızlı Hareket</div>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ["X", gx, setGx],
                ["Y", gy, setGy],
                ["Z", gz, setGz]
              ] as const
            ).map(([lbl, val, set]) => (
              <input
                key={lbl}
                value={val}
                onChange={(e) => set(e.target.value)}
                placeholder={lbl}
                className="mono w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
              />
            ))}
            <button
              onClick={() => act({ type: "goto", x: Number(gx), y: Number(gy), z: Number(gz) }, "Hedefe gidiliyor")}
              disabled={!gx || !gy || !gz}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-emerald-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              Git
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              placeholder="Oyuncu adı"
              className="w-40 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => act({ type: "goto-player", player }, `${player} yanına gidiliyor`)}
              disabled={!player}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              Yanına Git
            </button>
            <button
              onClick={() => act({ type: "follow", player, distance: 3 }, `${player} takip ediliyor`)}
              disabled={!player}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              Takip Et
            </button>
          </div>
        </div>

        {/* waypointler */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Waypointler</div>
          <div className="mb-2 flex gap-2">
            <input
              value={wpName}
              onChange={(e) => setWpName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && wpName && saveWaypointHere(wpName)}
              placeholder="Yeni waypoint adı"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => saveWaypointHere(wpName)}
              disabled={!wpName || bot.status !== "online"}
              title={bot.status !== "online" ? "Bot çevrimdışı" : "Botun şu anki konumunu kaydet"}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-indigo-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              Buradan Kaydet
            </button>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {waypoints.length === 0 && <div className="py-3 text-center text-xs text-zinc-600">Bu sunucuda waypoint yok</div>}
            {waypoints.map((wp) => (
              <div key={wp.id} className="flex items-center gap-2 rounded-lg bg-zinc-900/60 px-2 py-1.5 text-sm">
                <span className="font-medium text-zinc-200">{wp.name}</span>
                <span className="mono text-[11px] text-zinc-500">
                  {fmtPos(wp)} · {wp.dimension}
                </span>
                <div className="ml-auto flex gap-1.5">
                  <button onClick={() => gotoWp(wp)} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-emerald-300 hover:bg-zinc-700">
                    Git
                  </button>
                  <button onClick={() => delWp(wp)} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-red-300 hover:bg-zinc-700">
                    Sil
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* görev kuyruğu */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 flex items-center">
          <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Görev Kuyruğu</span>
          {(tasks.current || tasks.queue.length > 0) && (
            <button
              onClick={() => api.post(`/api/bots/${botId}/tasks/cancel-all`).catch(() => {})}
              className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-xs text-red-300 hover:bg-zinc-700"
            >
              Tümünü İptal
            </button>
          )}
        </div>

        {tasks.current ? (
          <div className="rounded-lg border border-indigo-900/60 bg-indigo-950/30 p-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
              <span className="text-sm font-medium text-zinc-100">{tasks.current.label}</span>
              <span className="text-[11px] text-zinc-500">({tasks.current.type})</span>
              <button
                onClick={() => cancelTask(tasks.current!)}
                className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-xs text-red-300 hover:bg-zinc-700"
              >
                İptal
              </button>
            </div>
            {tasks.current.progress && (
              <div className="mt-2">
                <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                  <span>{tasks.current.progress.label}</span>
                  {tasks.current.progress.total > 0 && (
                    <span className="mono">
                      {tasks.current.progress.done}/{tasks.current.progress.total}
                    </span>
                  )}
                </div>
                {tasks.current.progress.total > 0 && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-all"
                      style={{
                        width: `${Math.min(100, (tasks.current.progress.done / tasks.current.progress.total) * 100)}%`
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="py-2 text-center text-xs text-zinc-600 italic">Bot boşta — aktif görev yok</div>
        )}

        {tasks.queue.length > 0 && (
          <div className="mt-2 space-y-1">
            {tasks.queue.map((t, i) => (
              <div key={t.id} className="flex items-center gap-2 rounded bg-zinc-900/60 px-2 py-1 text-xs text-zinc-400">
                <span className="mono text-zinc-600">#{i + 1}</span>
                <span>{t.label}</span>
                <button
                  onClick={() => cancelTask(t)}
                  className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-zinc-700"
                >
                  İptal
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

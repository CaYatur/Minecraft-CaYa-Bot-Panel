import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { dimensionLabel, fmtPos } from "../lib/format";
import type { BotSnapshot, ServerProfile } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";
import { StatBar } from "./Bars";
import { StatusBadge } from "./StatusBadge";

export function BotCard({ bot, server }: { bot: BotSnapshot; server?: ServerProfile }) {
  const toast = useAppStore((s) => s.toast);
  const running = bot.status !== "stopped";
  const problem = bot.runtime.kickReason || bot.runtime.lastError;
  // ana envanter + hotbar doluluk (36 slot) — 30+ olunca kartta uyarı rozeti
  let invUsed: number | null = null;
  if (bot.inventory) {
    invUsed = 0;
    for (let s = 9; s <= 44; s++) if (bot.inventory.slots[s]) invUsed++;
  }

  const toggle = async () => {
    try {
      await api.post(`/api/bots/${bot.config.id}/${running ? "stop" : "start"}`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 transition-colors hover:border-zinc-700">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/bots/${bot.config.id}`} className="group min-w-0">
          <div className="truncate font-semibold text-zinc-100 group-hover:text-indigo-300">{bot.config.username}</div>
          <div className="truncate text-xs text-zinc-500">
            {server ? `${server.name} · ${server.host}:${server.port}` : "sunucu yok"}
          </div>
        </Link>
        <StatusBadge status={bot.status} />
      </div>

      {bot.status === "online" ? (
        <div className="flex flex-col gap-1.5">
          <StatBar value={bot.runtime.health} max={20} color="bg-red-500" label="Can" icon="❤️" />
          <StatBar value={bot.runtime.food} max={20} color="bg-amber-500" label="Açlık" icon="🍗" />
          <div className="mono flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              📍 {fmtPos(bot.runtime.position)} · {dimensionLabel(bot.runtime.dimension)}
            </span>
            <span className="flex items-center gap-2">
              {invUsed !== null && invUsed >= 30 && (
                <span className={invUsed >= 36 ? "text-red-400" : "text-amber-400"} title="Envanter doluluk">
                  🎒 {invUsed}/36
                </span>
              )}
              {bot.runtime.ping} ms
            </span>
          </div>
        </div>
      ) : problem ? (
        <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-xs leading-snug text-red-300">
          {problem}
        </div>
      ) : (
        <div className="text-xs text-zinc-600 italic">Bot kapalı</div>
      )}

      <div className="mt-auto flex items-center gap-2">
        <button
          onClick={toggle}
          className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            running
              ? "bg-zinc-800 text-zinc-300 hover:bg-red-900/50 hover:text-red-200"
              : "bg-emerald-600 text-white hover:bg-emerald-500"
          }`}
        >
          {running ? "Durdur" : "Başlat"}
        </button>
        <Link
          to={`/bots/${bot.config.id}`}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          Detay
        </Link>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { StatBar } from "../components/Bars";
import { ChatPanel } from "../components/ChatPanel";
import { CombatPanel } from "../components/CombatPanel";
import { GatherCraftPanel } from "../components/GatherCraftPanel";
import { LogPanel } from "../components/LogPanel";
import { InventoryPanel } from "../components/InventoryPanel";
import { StatusBadge } from "../components/StatusBadge";
import { BuildPanel } from "../components/BuildPanel";
import { NearbyPlayers } from "../components/NearbyPlayers";
import { SurvivalPanel } from "../components/SurvivalPanel";
import { TasksPanel } from "../components/TasksPanel";
import { api } from "../lib/api";
import { dimensionLabel, fmtPos } from "../lib/format";
import type { StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

type Tab = "chat" | "logs" | "inventory" | "tasks" | "combat" | "survival" | "work" | "build";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "💬 Sohbet" },
  { id: "logs", label: "📋 Loglar" },
  { id: "inventory", label: "🎒 Envanter" },
  { id: "tasks", label: "📌 Görevler" },
  { id: "combat", label: "⚔️ Dövüş" },
  { id: "survival", label: "🍖 Yaşam" },
  { id: "work", label: "🪓 İş" },
  { id: "build", label: "🏗️ Yapı" }
];

export function BotDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const bot = useAppStore((s) => s.bots[id]);
  const servers = useAppStore((s) => s.servers);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const toast = useAppStore((s) => s.toast);
  const [tab, setTab] = useState<Tab>("chat");

  if (!bot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
        <p>Bot bulunamadı.</p>
        <Link to="/" className="text-indigo-400 hover:underline">
          ← Panele dön
        </Link>
      </div>
    );
  }

  const server = servers.find((s) => s.id === bot.config.serverId);
  const running = bot.status !== "stopped";

  const refresh = async () => applySnapshot(await api.get<StateSnapshot>("/api/state"));

  const toggle = async () => {
    try {
      await api.post(`/api/bots/${id}/${running ? "stop" : "start"}`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const toggleAutostart = async () => {
    try {
      await api.patch(`/api/bots/${id}`, { autostart: !bot.config.autostart });
      await refresh();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    if (!confirm(`${bot.config.username} silinsin mi? Bu işlem geri alınamaz.`)) return;
    try {
      await api.del(`/api/bots/${id}`);
      toast("info", `${bot.config.username} silindi`);
      navigate("/");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const problem = bot.runtime.kickReason || bot.runtime.lastError;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-zinc-500 hover:text-zinc-300">
          ←
        </Link>
        <h1 className="text-xl font-bold text-zinc-100">{bot.config.username}</h1>
        <StatusBadge status={bot.status} />
        <span className="text-xs text-zinc-500">
          {server ? `${server.name} · ${server.host}:${server.port} · ${server.version}` : "sunucu profili yok"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={bot.config.autostart} onChange={toggleAutostart} />
            Otomatik başlat
          </label>
          <button
            onClick={toggle}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium ${
              running ? "bg-zinc-800 text-red-300 hover:bg-red-900/40" : "bg-emerald-600 text-white hover:bg-emerald-500"
            }`}
          >
            {running ? "■ Durdur" : "▶ Başlat"}
          </button>
          <button onClick={remove} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:bg-red-900/40 hover:text-red-300">
            Sil
          </button>
        </div>
      </div>

      {problem && bot.status !== "online" && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">{problem}</div>
      )}

      {/* vitals */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:grid-cols-4">
        <StatBar value={bot.runtime.health} max={20} color="bg-red-500" label="Can" icon="❤️" />
        <StatBar value={bot.runtime.food} max={20} color="bg-amber-500" label="Açlık" icon="🍗" />
        <div className="mono flex items-center gap-2 text-xs text-zinc-400">
          <span>⭐ Seviye {bot.runtime.xpLevel}</span>
          <span className="text-zinc-600">·</span>
          <span>{bot.runtime.ping} ms</span>
        </div>
        <div className="mono text-xs text-zinc-400">
          📍 {fmtPos(bot.runtime.position)} <span className="text-zinc-600">({dimensionLabel(bot.runtime.dimension)})</span>
        </div>
      </div>

      <NearbyPlayers botId={id} />

      {/* tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-t-lg px-4 py-2 text-sm transition-colors ${
              tab === t.id ? "border border-b-0 border-zinc-800 bg-zinc-900 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        {tab === "chat" && <ChatPanel botId={id} />}
        {tab === "logs" && <LogPanel botId={id} />}
        {tab === "inventory" && <InventoryPanel botId={id} />}
        {tab === "tasks" && <TasksPanel botId={id} />}
        {tab === "combat" && <CombatPanel botId={id} />}
        {tab === "survival" && <SurvivalPanel botId={id} />}
        {tab === "work" && <GatherCraftPanel botId={id} />}
        {tab === "build" && <BuildPanel botId={id} />}
      </div>
    </div>
  );
}

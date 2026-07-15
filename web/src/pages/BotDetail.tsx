import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Axe,
  Backpack,
  Construction,
  Drumstick,
  Heart,
  ListChecks,
  MapPin,
  MessageSquare,
  RotateCcw,
  ScrollText,
  Star,
  Swords
} from "lucide-react";
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
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { dimensionLabel, fmtPos } from "../lib/format";
import type { StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

type Tab = "chat" | "logs" | "inventory" | "tasks" | "combat" | "survival" | "work" | "build";

export function BotDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const bot = useAppStore((s) => s.bots[id]);
  const servers = useAppStore((s) => s.servers);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const toast = useAppStore((s) => s.toast);
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("chat");
  /** yetkili oyuncular — virgülle ayrılmış metin */
  const [authText, setAuthText] = useState("");
  const [authSaving, setAuthSaving] = useState(false);

  const TABS: { id: Tab; label: string; icon: typeof MessageSquare }[] = [
    { id: "chat", label: t("botDetail.tabs.chat"), icon: MessageSquare },
    { id: "logs", label: t("botDetail.tabs.logs"), icon: ScrollText },
    { id: "inventory", label: t("botDetail.tabs.inventory"), icon: Backpack },
    { id: "tasks", label: t("botDetail.tabs.tasks"), icon: ListChecks },
    { id: "combat", label: t("botDetail.tabs.combat"), icon: Swords },
    { id: "survival", label: t("botDetail.tabs.survival"), icon: Drumstick },
    { id: "work", label: t("botDetail.tabs.work"), icon: Axe },
    { id: "build", label: t("botDetail.tabs.build"), icon: Construction }
  ];

  // bot değişince yetkili listesini senkronla
  useEffect(() => {
    if (!bot) return;
    setAuthText((bot.config.authorizedPlayers ?? []).join(", "));
  }, [id, bot?.config.authorizedPlayers?.join(",")]);

  if (!bot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
        <p>{t("botDetail.notFound")}</p>
        <Link to="/" className="text-indigo-400 hover:underline">
          {t("botDetail.backToPanel")}
        </Link>
      </div>
    );
  }

  const server = servers.find((s) => s.id === bot.config.serverId);
  const running = bot.status !== "stopped";

  const refresh = async () => applySnapshot(await api.get<StateSnapshot>("/api/state"));

  const saveAuthorized = async () => {
    const list = authText
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setAuthSaving(true);
    try {
      await api.patch(`/api/bots/${id}`, { authorizedPlayers: list });
      await refresh();
      toast("success", t("botDetail.authorizedSaved", { n: list.length }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setAuthSaving(false);
    }
  };

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
    if (!confirm(t("botDetail.deleteConfirm", { name: bot.config.username }))) return;
    try {
      await api.del(`/api/bots/${id}`);
      toast("info", t("botDetail.deleted", { name: bot.config.username }));
      navigate("/");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const resetWork = async () => {
    if (!confirm(t("botDetail.resetWorkConfirm", { name: bot.config.username }))) return;
    try {
      await api.post(`/api/bots/${id}/action`, { type: "reset-work" });
      toast("info", t("botDetail.resetWorkDone"));
      await refresh();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const problem = bot.runtime.kickReason || bot.runtime.lastError;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-zinc-500 hover:text-zinc-300">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-xl font-bold text-zinc-100">{bot.config.username}</h1>
        <StatusBadge status={bot.status} />
        <span className="text-xs text-zinc-500">
          {server
            ? `${server.name} · ${server.host}:${server.port} · ${server.version}`
            : t("settings.serverProfiles")}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={bot.config.autostart} onChange={toggleAutostart} />
            {t("botDetail.autostart")}
          </label>
          <button
            type="button"
            onClick={() => void resetWork()}
            title={t("botDetail.resetWorkTitle")}
            className="flex items-center gap-1.5 rounded-lg border border-amber-800/70 bg-amber-950/50 px-3 py-1.5 text-sm font-medium text-amber-200 hover:bg-amber-900/50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> {t("botDetail.resetWork")}
          </button>
          <button
            onClick={toggle}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium ${
              running ? "bg-zinc-800 text-red-300 hover:bg-red-900/40" : "bg-emerald-600 text-white hover:bg-emerald-500"
            }`}
          >
            {running ? t("botDetail.stop") : t("botDetail.start")}
          </button>
          <button
            onClick={remove}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:bg-red-900/40 hover:text-red-300"
          >
            {t("botDetail.delete")}
          </button>
        </div>
      </div>

      {problem && bot.status !== "online" && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">{problem}</div>
      )}

      <div className="grid grid-cols-2 gap-x-8 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:grid-cols-4">
        <StatBar
          value={bot.runtime.health}
          max={20}
          color="bg-red-500"
          label={t("botDetail.health")}
          icon={<Heart className="h-3.5 w-3.5 text-red-400" />}
        />
        <StatBar
          value={bot.runtime.food}
          max={20}
          color="bg-amber-500"
          label={t("botDetail.food")}
          icon={<Drumstick className="h-3.5 w-3.5 text-amber-400" />}
        />
        <div className="mono flex items-center gap-2 text-xs text-zinc-400">
          <span className="flex items-center gap-1">
            <Star className="h-3.5 w-3.5" /> {t("botDetail.level", { n: bot.runtime.xpLevel })}
          </span>
          <span className="text-zinc-600">·</span>
          <span>{bot.runtime.ping} ms</span>
        </div>
        <div className="mono flex items-center gap-1 text-xs text-zinc-400">
          <MapPin className="h-3.5 w-3.5 shrink-0" /> {fmtPos(bot.runtime.position)}{" "}
          <span className="text-zinc-600">({dimensionLabel(bot.runtime.dimension, locale)})</span>
        </div>
      </div>

      {/* Yetkili oyuncular — otomasyon sohbet komutları (İ3) */}
      <div className="rounded-xl border border-indigo-900/40 bg-indigo-950/15 px-4 py-3">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <div className="text-xs font-semibold tracking-wide text-indigo-300/90 uppercase">
            {t("botDetail.authorized")}
          </div>
          <span className="text-[10px] text-zinc-500">{t("botDetail.authorizedHint")}</span>
        </div>
        <p className="mb-2 text-[11px] leading-relaxed text-zinc-500">{t("botDetail.authorizedHelp")}</p>
        <div className="flex flex-wrap gap-2">
          <input
            value={authText}
            onChange={(e) => setAuthText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveAuthorized();
            }}
            placeholder={t("botDetail.authorizedPlaceholder")}
            className="min-w-[14rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
          <button
            type="button"
            disabled={authSaving}
            onClick={() => void saveAuthorized()}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            {authSaving ? "…" : t("botDetail.authorizedSave")}
          </button>
        </div>
        {(bot.config.authorizedPlayers ?? []).length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {(bot.config.authorizedPlayers ?? []).map((p) => (
              <span
                key={p}
                className="rounded-full bg-indigo-950/60 px-2 py-0.5 text-[10px] text-indigo-200"
              >
                {p}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[10px] text-amber-500/90">{t("botDetail.authorizedEmpty")}</p>
        )}
      </div>

      <NearbyPlayers botId={id} />

      <div className="flex gap-1 border-b border-zinc-800">
        {TABS.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`flex items-center gap-1.5 rounded-t-lg px-4 py-2 text-sm transition-colors ${
              tab === item.id
                ? "border border-b-0 border-zinc-800 bg-zinc-900 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <item.icon className="h-3.5 w-3.5" /> {item.label}
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

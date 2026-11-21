import { useEffect, useState } from "react";
import { AddBotModal } from "../components/AddBotModal";
import { AllChatPanel } from "../components/AllChatPanel";
import { BotCard } from "../components/BotCard";
import { BotLogo } from "../components/BotLogo";
import { LogPanel } from "../components/LogPanel";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import type { BulkResult } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

export function Dashboard() {
  const bots = useAppStore((s) => s.bots);
  const snapshotLoaded = useAppStore((s) => s.snapshotLoaded);
  const servers = useAppStore((s) => s.servers);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();
  const [showAdd, setShowAdd] = useState(false);
  const [bottomTab, setBottomTab] = useState<"logs" | "chat">("logs");

  const list = Object.values(bots);
  const onlineCount = list.filter((b) => b.status === "online").length;

  // issue #34 — seçili botlara toplu işlem
  const [selected, setSelected] = useState<string[]>([]);
  const [chatText, setChatText] = useState("");
  const [hotbar, setHotbar] = useState(1);
  const [slot, setSlot] = useState(0);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [lastResult, setLastResult] = useState<BulkResult | null>(null);
  const botIds = list.map((b) => b.config.id).join(",");
  useEffect(() => {
    setSelected((cur) => cur.filter((id) => bots[id]));
  }, [botIds]);
  const toggleSelect = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const runBulk = async (action: Record<string, unknown>) => {
    if (!selected.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const res = await api.post<BulkResult>("/api/bots/bulk-action", { ids: selected, action });
      setLastResult(res);
      toast(res.failCount ? "error" : "success", t("dashboard.bulkDone", { action: res.action, ok: res.okCount, fail: res.failCount }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };
  const bulkBtn = "rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50";

  const bulk = async (op: "start-all" | "stop-all") => {
    try {
      await api.post(`/api/bots/${op}`);
      toast("info", op === "start-all" ? t("dashboard.startingAll") : t("dashboard.stoppingAll"));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">{t("dashboard.title")}</h1>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
          {t("dashboard.onlineCount", { online: onlineCount, total: list.length })}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => bulk("start-all")}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-emerald-300 hover:bg-zinc-700"
          >
            {t("dashboard.startAll")}
          </button>
          <button
            onClick={() => bulk("stop-all")}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-red-300 hover:bg-zinc-700"
          >
            {t("dashboard.stopAll")}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            {t("dashboard.addBot")}
          </button>
        </div>
      </div>

      {list.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3" aria-busy={bulkBusy}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="text-[11px] font-semibold tracking-wide text-indigo-300 uppercase">{t("dashboard.bulkTitle")}</span>
            <span className={`rounded-full px-2 py-0.5 font-semibold ${selected.length ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-400"}`}>
              {t("dashboard.selectedCount", { count: selected.length })}
            </span>
            <button type="button" className={bulkBtn} onClick={() => setSelected(list.map((b) => b.config.id))}>
              {t("dashboard.selectAll")}
            </button>
            <button type="button" className={bulkBtn} disabled={!selected.length} onClick={() => setSelected([])}>
              {t("dashboard.clearSelection")}
            </button>
            <span className="mx-1 h-4 w-px bg-zinc-700" />
            <button type="button" className={`${bulkBtn} text-emerald-300`} disabled={!selected.length || bulkBusy} onClick={() => void runBulk({ type: "start" })}>
              {t("dashboard.bulkStart")}
            </button>
            <button type="button" className={`${bulkBtn} text-red-300`} disabled={!selected.length || bulkBusy} onClick={() => void runBulk({ type: "stop" })}>
              {t("dashboard.bulkStop")}
            </button>
            <button type="button" className={bulkBtn} disabled={!selected.length || bulkBusy} onClick={() => void runBulk({ type: "stop-work" })}>
              {t("dashboard.bulkStopWork")}
            </button>
          </div>
          {!selected.length && <p className="text-[11px] text-zinc-500">{t("dashboard.bulkHint")}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <form
              className="flex min-w-64 flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const text = chatText.trim();
                if (!text) return;
                void runBulk({ type: "chat", text }).then(() => setChatText(""));
              }}
            >
              <input
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                maxLength={256}
                placeholder={t("dashboard.bulkChatPlaceholder")}
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200"
              />
              <button type="submit" className={bulkBtn} disabled={!selected.length || bulkBusy || !chatText.trim()}>
                {t("dashboard.bulkChat")}
              </button>
            </form>
            <button type="button" className={bulkBtn} disabled={!selected.length || bulkBusy} onClick={() => void runBulk({ type: "use-item" })}>
              {t("dashboard.bulkUse")}
            </button>
            <label className="flex items-center gap-1">
              {t("dashboard.bulkHotbar")}
              <input
                type="number"
                min={1}
                max={9}
                value={hotbar}
                onChange={(e) => setHotbar(Math.max(1, Math.min(9, Number(e.target.value) || 1)))}
                className="w-12 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-200"
              />
            </label>
            <button type="button" className={bulkBtn} disabled={!selected.length || bulkBusy} onClick={() => void runBulk({ type: "hotbar", hotbar: hotbar - 1 })}>
              {t("dashboard.bulkHotbarSet")}
            </button>
            <label className="flex items-center gap-1">
              {t("dashboard.bulkSlot")}
              <input
                type="number"
                min={0}
                max={89}
                value={slot}
                onChange={(e) => setSlot(Math.max(0, Math.min(89, Number(e.target.value) || 0)))}
                className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-200"
              />
            </label>
            <button type="button" className={bulkBtn} disabled={!selected.length || bulkBusy} onClick={() => void runBulk({ type: "click-slot", slot })}>
              {t("dashboard.bulkClick")}
            </button>
            <button type="button" className={bulkBtn} disabled={!selected.length || bulkBusy} onClick={() => void runBulk({ type: "close-window" })}>
              {t("dashboard.bulkClose")}
            </button>
          </div>
          {lastResult && lastResult.results.length > 0 && (
            <details className="text-[11px] text-zinc-500">
              <summary className="cursor-pointer">
                {t("dashboard.bulkResults")}: {t("dashboard.bulkDone", { action: lastResult.action, ok: lastResult.okCount, fail: lastResult.failCount })}
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {lastResult.results.map((r) => (
                  <li key={r.botId} className={r.ok ? "text-zinc-400" : "text-red-300"}>
                    {r.username}: {r.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {!snapshotLoaded ? (
        <p className="text-sm text-zinc-500" aria-busy="true">{t("common.loading")}</p>
      ) : list.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 text-zinc-500">
          <BotLogo className="h-12 w-12 opacity-70" />
          <p className="text-sm">{t("dashboard.empty")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((b) => (
            <BotCard
              key={b.config.id}
              bot={b}
              server={servers.find((s) => s.id === b.config.serverId)}
              selected={selected.includes(b.config.id)}
              onToggleSelect={() => toggleSelect(b.config.id)}
            />
          ))}
        </div>
      )}

      <div className="h-64 shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="mb-1 flex items-center gap-3">
          <button
            onClick={() => setBottomTab("logs")}
            className={`text-xs font-semibold tracking-wide uppercase ${bottomTab === "logs" ? "text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}
          >
            {t("dashboard.systemLogs")}
          </button>
          <button
            onClick={() => setBottomTab("chat")}
            className={`text-xs font-semibold tracking-wide uppercase ${bottomTab === "chat" ? "text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}
          >
            {t("dashboard.allChat")}
          </button>
        </div>
        {bottomTab === "logs" ? <LogPanel /> : <AllChatPanel />}
      </div>

      {showAdd && <AddBotModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

import { useState } from "react";
import { AddBotModal } from "../components/AddBotModal";
import { AllChatPanel } from "../components/AllChatPanel";
import { BotCard } from "../components/BotCard";
import { LogPanel } from "../components/LogPanel";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";

export function Dashboard() {
  const bots = useAppStore((s) => s.bots);
  const servers = useAppStore((s) => s.servers);
  const toast = useAppStore((s) => s.toast);
  const [showAdd, setShowAdd] = useState(false);
  const [bottomTab, setBottomTab] = useState<"logs" | "chat">("logs");

  const list = Object.values(bots);
  const onlineCount = list.filter((b) => b.status === "online").length;

  const bulk = async (op: "start-all" | "stop-all") => {
    try {
      await api.post(`/api/bots/${op}`);
      toast("info", op === "start-all" ? "Botlar kademeli başlatılıyor…" : "Tüm botlar durduruluyor");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">Botlar</h1>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
          {onlineCount}/{list.length} çevrimiçi
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => bulk("start-all")}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-emerald-300 hover:bg-zinc-700"
          >
            ▶ Tümünü Başlat
          </button>
          <button
            onClick={() => bulk("stop-all")}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-red-300 hover:bg-zinc-700"
          >
            ■ Tümünü Durdur
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            + Bot Ekle
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 text-zinc-500">
          <span className="text-4xl">🐺</span>
          <p className="text-sm">Henüz bot yok. "+ Bot Ekle" ile ilk botunu oluştur.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((b) => (
            <BotCard key={b.config.id} bot={b} server={servers.find((s) => s.id === b.config.serverId)} />
          ))}
        </div>
      )}

      <div className="h-64 shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="mb-1 flex items-center gap-3">
          <button
            onClick={() => setBottomTab("logs")}
            className={`text-xs font-semibold tracking-wide uppercase ${bottomTab === "logs" ? "text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}
          >
            Sistem Logları
          </button>
          <button
            onClick={() => setBottomTab("chat")}
            className={`text-xs font-semibold tracking-wide uppercase ${bottomTab === "chat" ? "text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}
          >
            Birleşik Sohbet
          </button>
          <span className="ml-auto text-[10px] text-zinc-600">İ1 — sistem mesajları asla oyun sohbetine yazılmaz</span>
        </div>
        <div className="h-[calc(100%-1.5rem)]">{bottomTab === "logs" ? <LogPanel /> : <AllChatPanel />}</div>
      </div>

      {showAdd && <AddBotModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

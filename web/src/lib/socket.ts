import { io } from "socket.io-client";
import { useAppStore } from "../stores/useAppStore";
import { EV } from "./events";
import type { BotSnapshot, ChatEntry, LogEntry, StateSnapshot } from "./types";

// Aynı origin (vite proxy → 3001). Tek socket örneği, modül yüklenince bağlanır.
export const socket = io({ transports: ["websocket", "polling"] });

const store = () => useAppStore.getState();

socket.on("connect", () => store().setConnected(true));
socket.on("disconnect", () => store().setConnected(false));

socket.on(EV.STATE_SNAPSHOT, (s: StateSnapshot) => store().applySnapshot(s));

socket.on(
  EV.BOT_STATUS,
  (p: { botId: string; status: BotSnapshot["status"]; kickReason?: string; lastError?: string }) => {
    store().patchBot(p.botId, { status: p.status });
    store().patchRuntime(p.botId, { kickReason: p.kickReason, lastError: p.lastError });
  }
);

socket.on(
  EV.BOT_VITALS,
  (p: { botId: string; health: number; food: number; foodSaturation: number; xpLevel: number; ping: number }) => {
    const { botId, ...rest } = p;
    store().patchRuntime(botId, rest);
  }
);

socket.on(
  EV.BOT_POSITION,
  (p: { botId: string; position: { x: number; y: number; z: number }; dimension: string }) => {
    store().patchRuntime(p.botId, { position: p.position, dimension: p.dimension });
  }
);

socket.on(EV.BOT_CHAT, (e: ChatEntry) => store().addChat(e));
socket.on(EV.BOT_CHAT_QUEUE, (p: { botId: string; length: number }) => store().setChatQueue(p.botId, p.length));
socket.on(EV.BOT_LOG, (e: LogEntry) => store().addLog(e));
socket.on(EV.PANEL_NOTIFY, (p: { level?: "info" | "success" | "error"; message: string }) =>
  store().toast(p.level ?? "info", p.message)
);

export function sendChat(botId: string, text: string) {
  socket.emit(EV.SEND_CHAT, { botId, text });
}

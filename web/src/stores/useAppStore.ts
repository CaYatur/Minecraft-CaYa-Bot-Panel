import { create } from "zustand";
import type { BotSnapshot, ChatEntry, LogEntry, ServerProfile, StateSnapshot, Waypoint } from "../lib/types";

const CHAT_CAP = 500;
const LOG_CAP = 1000;

export interface Toast {
  id: number;
  level: "info" | "success" | "error";
  message: string;
}

interface AppState {
  connected: boolean;
  snapshotLoaded: boolean;
  servers: ServerProfile[];
  supportedVersions: string[];
  bots: Record<string, BotSnapshot>;
  waypoints: Record<string, Waypoint[]>;
  chat: Record<string, ChatEntry[]>;
  chatQueue: Record<string, number>;
  logs: LogEntry[];
  toasts: Toast[];

  setConnected(v: boolean): void;
  applySnapshot(s: StateSnapshot): void;
  patchBot(botId: string, patch: Partial<BotSnapshot>): void;
  patchRuntime(botId: string, patch: Partial<BotSnapshot["runtime"]>): void;
  addChat(e: ChatEntry): void;
  setChatHistory(botId: string, entries: ChatEntry[]): void;
  setChatQueue(botId: string, n: number): void;
  addLog(e: LogEntry): void;
  toast(level: Toast["level"], message: string): void;
  dismissToast(id: number): void;
}

let toastSeq = 1;

export const useAppStore = create<AppState>((set, get) => ({
  connected: false,
  snapshotLoaded: false,
  servers: [],
  supportedVersions: [],
  bots: {},
  waypoints: {},
  chat: {},
  chatQueue: {},
  logs: [],
  toasts: [],

  setConnected: (v) => set({ connected: v }),

  applySnapshot: (s) =>
    set((st) => {
      const bots: Record<string, BotSnapshot> = {};
      for (const b of s.bots) bots[b.config.id] = b;
      const chat = { ...st.chat };
      for (const id of Object.keys(chat)) if (!bots[id]) delete chat[id];
      return {
        servers: s.servers,
        supportedVersions: s.supportedVersions,
        bots,
        chat,
        waypoints: s.waypoints ?? {},
        snapshotLoaded: true
      };
    }),

  patchBot: (botId, patch) =>
    set((st) => {
      const cur = st.bots[botId];
      if (!cur) return st;
      return { bots: { ...st.bots, [botId]: { ...cur, ...patch } } };
    }),

  patchRuntime: (botId, patch) =>
    set((st) => {
      const cur = st.bots[botId];
      if (!cur) return st;
      return { bots: { ...st.bots, [botId]: { ...cur, runtime: { ...cur.runtime, ...patch } } } };
    }),

  addChat: (e) =>
    set((st) => {
      const list = [...(st.chat[e.botId] ?? []), e];
      if (list.length > CHAT_CAP) list.splice(0, list.length - CHAT_CAP);
      return { chat: { ...st.chat, [e.botId]: list } };
    }),

  setChatHistory: (botId, entries) => set((st) => ({ chat: { ...st.chat, [botId]: entries.slice(-CHAT_CAP) } })),

  setChatQueue: (botId, n) => set((st) => ({ chatQueue: { ...st.chatQueue, [botId]: n } })),

  addLog: (e) =>
    set((st) => {
      const logs = [...st.logs, e];
      if (logs.length > LOG_CAP) logs.splice(0, logs.length - LOG_CAP);
      return { logs };
    }),

  toast: (level, message) => {
    const id = toastSeq++;
    set((st) => ({ toasts: [...st.toasts, { id, level, message }] }));
    setTimeout(() => get().dismissToast(id), 5000);
  },

  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
}));

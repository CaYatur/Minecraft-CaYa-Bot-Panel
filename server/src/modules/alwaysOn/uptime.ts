import { loadJson, saveJson } from "../../persistence/store";

export interface DisconnectRecord {
  ts: number;
  kind: string;
  text: string;
}

export interface BotUptime {
  totalMs: number;
  sessions: number;
  disconnects: number;
  reasons: DisconnectRecord[];
  onlineSince: number | null;
}

const FILE = "uptime.json";
const MAX_REASONS = 20;

function empty(): BotUptime {
  return { totalMs: 0, sessions: 0, disconnects: 0, reasons: [], onlineSince: null };
}

function all(): Record<string, BotUptime> {
  return loadJson<Record<string, BotUptime>>(FILE, {});
}

export function uptimeFor(botId: string, now = Date.now()): BotUptime & { currentMs: number } {
  const row = all()[botId] ?? empty();
  const currentMs = row.onlineSince ? Math.max(0, now - row.onlineSince) : 0;
  return { ...row, currentMs };
}

export function markSessionStart(botId: string, now = Date.now()): void {
  const data = all();
  const row = data[botId] ?? empty();
  if (row.onlineSince) return;
  row.sessions += 1;
  row.onlineSince = now;
  data[botId] = row;
  void saveJson(FILE, data);
}

export function markSessionEnd(botId: string, reason: { kind: string; text: string }, now = Date.now()): void {
  const data = all();
  const row = data[botId] ?? empty();
  if (row.onlineSince) {
    row.totalMs += Math.max(0, now - row.onlineSince);
    row.onlineSince = null;
  }
  row.disconnects += 1;
  const text = reason.text.replace(/\s+/g, " ").slice(0, 180);
  row.reasons = [...row.reasons, { ts: now, kind: reason.kind, text }].slice(-MAX_REASONS);
  data[botId] = row;
  void saveJson(FILE, data);
}

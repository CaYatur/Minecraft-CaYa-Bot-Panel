import * as fs from "fs";
import * as path from "path";
import { LOGS_DIR } from "../config/paths";
import type { LogEntry, LogLevel } from "../types";

const CONSOLE_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  success: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m"
};
const RESET = "\x1b[0m";

const RING_CAP = 2000;

type Sink = (entry: LogEntry) => void;

/**
 * Central log hub (İ1): every entry goes to console + daily jsonl file + live sinks
 * (Socket.IO). NOTHING here ever writes to in-game chat.
 */
class LogHub {
  private sinks: Sink[] = [];
  readonly ring: LogEntry[] = [];

  addSink(sink: Sink) {
    this.sinks.push(sink);
  }

  push(entry: LogEntry) {
    this.ring.push(entry);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);

    const time = new Date(entry.ts).toLocaleTimeString("tr-TR", { hour12: false });
    const who = entry.botId ? `${entry.source}·${entry.botId.slice(0, 6)}` : entry.source;
    // eslint-disable-next-line no-console
    console.log(
      `${CONSOLE_COLORS[entry.level]}[${time}] ${entry.level.toUpperCase().padEnd(7)} [${who}] ${entry.message}${
        entry.detail ? " — " + entry.detail : ""
      }${RESET}`
    );

    const day = new Date(entry.ts).toISOString().slice(0, 10);
    fs.appendFile(path.join(LOGS_DIR, `app-${day}.jsonl`), JSON.stringify(entry) + "\n", () => {});

    for (const sink of this.sinks) {
      try {
        sink(entry);
      } catch {
        /* sink errors must never break logging */
      }
    }
  }

  recent(botId?: string, limit = 300): LogEntry[] {
    const src = botId ? this.ring.filter((e) => e.botId === botId || e.botId === undefined) : this.ring;
    return src.slice(-limit);
  }
}

export const logHub = new LogHub();

export interface BotLogger {
  debug(message: string, detail?: string): void;
  info(message: string, detail?: string): void;
  success(message: string, detail?: string): void;
  warn(message: string, detail?: string): void;
  error(message: string, detail?: string): void;
}

export function createLogger(source: string, botId?: string): BotLogger {
  const make =
    (level: LogLevel) =>
    (message: string, detail?: string) =>
      logHub.push({ ts: Date.now(), botId, level, source, message, detail });
  return {
    debug: make("debug"),
    info: make("info"),
    success: make("success"),
    warn: make("warn"),
    error: make("error")
  };
}

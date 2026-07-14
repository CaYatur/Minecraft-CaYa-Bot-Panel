// server/src/types.ts'in panel tarafı aynası (ortak paket: Backlog).

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  version: string;
  note?: string;
}

export type BotStatus = "stopped" | "connecting" | "online" | "reconnecting" | "kicked" | "error";

export interface BotConfig {
  id: string;
  username: string;
  serverId: string;
  autostart: boolean;
  authorizedPlayers: string[];
  inventory: { autoBestGear: boolean; bannedItems: string[]; keepItems: string[] };
  combat: {
    defendMode: "off" | "mob" | "player" | "all";
    reach: number;
    cpsCap: number;
    reactionMsMin: number;
    reactionMsMax: number;
    turnSpeedDegPerTick: number;
    jumpCrit: boolean;
    fleeAtHealth: number;
    chaseDistance: number;
  };
  survival: { autoEat: boolean; eatAtFood: number; foodBlacklist: string[] };
  chat: { minMessageIntervalMs: number };
  movement: { canDig: boolean; allowSprint: boolean; allowParkour: boolean; scaffoldBlocks: string[] };
}

export interface BotRuntimeState {
  health: number;
  food: number;
  foodSaturation: number;
  xpLevel: number;
  position: { x: number; y: number; z: number };
  dimension: string;
  ping: number;
  kickReason?: string;
  lastError?: string;
}

export type ChatKind = "player" | "whisper" | "server";

export interface ChatEntry {
  ts: number;
  botId: string;
  kind: ChatKind;
  username?: string;
  self?: boolean;
  text: string;
  ansi?: string;
}

export type LogLevel = "debug" | "info" | "success" | "warn" | "error";

export interface LogEntry {
  ts: number;
  botId?: string;
  level: LogLevel;
  source: string;
  message: string;
  detail?: string;
}

export interface TaskSummary {
  id: string;
  type: string;
  label: string;
  state: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
  progress?: { done: number; total: number; label?: string };
}

export interface BotSnapshot {
  config: BotConfig;
  status: BotStatus;
  runtime: BotRuntimeState;
  chatQueueLength: number;
  currentTask?: TaskSummary | null;
}

export interface StateSnapshot {
  servers: ServerProfile[];
  bots: BotSnapshot[];
  supportedVersions: string[];
}

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

export interface DeathRecord {
  x: number;
  y: number;
  z: number;
  dimension: string;
  ts: number;
  lootUntil: number;
}

export interface CompanionState {
  followPlayer: string | null;
  followDistance: number;
  attackPlayer: string | null;
  protectPlayer: string | null;
  protectSettings: {
    range: number;
    retaliateMobs: boolean;
    retaliatePlayers: boolean;
    whitelist: string[];
  };
}

export interface CombatRuntime {
  defendMode: "off" | "mob" | "player" | "all";
  fighting: boolean;
  mode: "idle" | "attacking" | "defending" | "fleeing" | "protecting";
  activeTarget: string | null;
  lastDeath: DeathRecord | null;
  companion: CompanionState;
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
  error?: string;
}

export interface Waypoint {
  id: string;
  serverId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  note?: string;
}

export interface InventoryItem {
  slot: number;
  name: string;
  displayName: string;
  count: number;
  durability?: { left: number; max: number };
  enchants: string[];
}

export interface InventorySnapshot {
  slots: (InventoryItem | null)[];
  heldQuickBar: number;
  ts: number;
}

export interface BotSnapshot {
  config: BotConfig;
  status: BotStatus;
  runtime: BotRuntimeState;
  chatQueueLength: number;
  tasks: { current: TaskSummary | null; queue: TaskSummary[] };
  inventory: InventorySnapshot | null;
  combat: CombatRuntime;
}

export interface StateSnapshot {
  servers: ServerProfile[];
  bots: BotSnapshot[];
  waypoints: Record<string, Waypoint[]>;
  supportedVersions: string[];
  rules?: unknown[];
  worldMemory?: { chests: unknown[]; ores: unknown[] };
}

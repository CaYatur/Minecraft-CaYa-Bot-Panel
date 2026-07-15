import * as crypto from "crypto";

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  /** minecraft version, e.g. "1.20.4", or "auto" for mineflayer auto-detect */
  version: string;
  note?: string;
}

export type BotStatus =
  | "stopped"
  | "connecting"
  | "online"
  | "reconnecting"
  | "kicked"
  | "error";

export interface CombatConfig {
  /** self-defense target selection */
  defendMode: "off" | "mob" | "player" | "all";
  reach: number;
  cpsCap: number; // 1.8-style cap; 1.9+ uses weapon charge instead
  reactionMsMin: number;
  reactionMsMax: number;
  turnSpeedDegPerTick: number;
  jumpCrit: boolean;
  fleeAtHealth: number;
  chaseDistance: number;
}

/** last death position for loot recovery (Faz 6) */
export interface DeathRecord {
  x: number;
  y: number;
  z: number;
  dimension: string;
  ts: number;
  /** Date.now() deadline for ~5 min item despawn */
  lootUntil: number;
}

/** Yakındaki oyuncular paneli — takip / saldırı / koruma (toggle) */
export interface CompanionState {
  followPlayer: string | null;
  followDistance: number;
  attackPlayer: string | null;
  /**
   * Korunan oyuncular (çoklu). Bot ana kişiyi (`followPlayer`) takip eder;
   * listedekilerden herhangi birinin yanında tehdit olursa müdahale eder.
   */
  protectPlayers: string[];
  /**
   * Geriye uyum / özet etiket: takip edilen korunan veya listenin ilki.
   * @deprecated paneller `protectPlayers` kullanmalı
   */
  protectPlayer: string | null;
  protectSettings: {
    /** her korunanın etrafında tehdit tarama yarıçapı */
    range: number;
    retaliateMobs: boolean;
    retaliatePlayers: boolean;
    /** bu isimler korunan'a vursa bile bot saldırmasın */
    whitelist: string[];
  };
}

export interface CombatRuntime {
  defendMode: CombatConfig["defendMode"];
  fighting: boolean;
  mode: "idle" | "attacking" | "defending" | "fleeing" | "protecting";
  activeTarget: string | null;
  lastDeath: DeathRecord | null;
  companion: CompanionState;
}

export interface MovementConfig {
  canDig: boolean;
  allowSprint: boolean;
  allowParkour: boolean;
  /** sacrificial blocks the bot may place to cross obstacles */
  scaffoldBlocks: string[];
}

export interface BotConfig {
  id: string;
  username: string;
  serverId: string;
  autostart: boolean;
  /** players allowed to trigger chat-command automations (İ3) */
  authorizedPlayers: string[];
  inventory: {
    autoBestGear: boolean;
    bannedItems: string[];
    keepItems: string[];
  };
  combat: CombatConfig;
  survival: {
    autoEat: boolean;
    eatAtFood: number;
    foodBlacklist: string[];
  };
  chat: {
    minMessageIntervalMs: number;
  };
  movement: MovementConfig;
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
  /** true when the sender is this bot itself (echo of own message) */
  self?: boolean;
  text: string;
  /** ANSI-colored variant for panel rendering (from prismarine-chat toAnsi) */
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
  /** pencere slot numarası (oyuncu envanteri: 5-8 zırh, 9-35 ana, 36-44 hotbar, 45 offhand) */
  slot: number;
  name: string;
  displayName: string;
  count: number;
  durability?: { left: number; max: number };
  enchants: string[];
}

export interface InventorySnapshot {
  /** 0-45 arası pencere slotları (boş slot = null) */
  slots: (InventoryItem | null)[];
  /** seçili hotbar slotu (0-8) */
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

export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function newId(): string {
  return crypto.randomUUID();
}

export function defaultRuntime(): BotRuntimeState {
  return {
    health: 0,
    food: 0,
    foodSaturation: 0,
    xpLevel: 0,
    position: { x: 0, y: 0, z: 0 },
    dimension: "overworld",
    ping: 0
  };
}

export function defaultBotConfig(username: string, serverId: string): BotConfig {
  return {
    id: newId(),
    username,
    serverId,
    autostart: false,
    authorizedPlayers: [],
    inventory: { autoBestGear: true, bannedItems: [], keepItems: [] },
    combat: {
      defendMode: "off",
      reach: 3.0,
      cpsCap: 8,
      reactionMsMin: 150,
      reactionMsMax: 300,
      turnSpeedDegPerTick: 30,
      jumpCrit: true,
      fleeAtHealth: 6,
      chaseDistance: 24
    },
    survival: {
      autoEat: true,
      eatAtFood: 14,
      foodBlacklist: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "suspicious_stew"]
    },
    chat: { minMessageIntervalMs: 1500 },
    movement: {
      canDig: true,
      allowSprint: true,
      allowParkour: true,
      scaffoldBlocks: ["dirt", "cobblestone", "netherrack"]
    }
  };
}

/** deep-merge a partial config patch into an existing config (arrays are replaced) */
export function mergeConfig<T extends object>(base: T, patch: Partial<T>): T {
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch as object)) {
    if (v === undefined) continue;
    const cur = (base as any)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = mergeConfig(cur, v as any);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

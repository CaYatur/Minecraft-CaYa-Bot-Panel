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
    /** öz savunma tarama yarıçapı */
    defendRange?: number;
    reach: number;
    cpsCap: number;
    reactionMsMin: number;
    reactionMsMax: number;
    turnSpeedDegPerTick: number;
    jumpCrit: boolean;
    fleeAtHealth: number;
    chaseDistance: number;
    /** hedefe kilitliyken yakın tehditlere ara vuruş */
    cleaveNearby?: boolean;
    cleaveRange?: number;
    cleaveMobs?: boolean;
    cleavePlayers?: boolean;
  };
  survival: {
    autoEat: boolean;
    eatAtFood: number;
    foodBlacklist: string[];
    fallGuard?: {
      enabled: boolean;
      minDamageHp: number;
      lethalHealthMargin: number;
      mlgTriggerBlocks: number;
      onlyWhenDangerous: boolean;
      autoReclaim?: boolean;
      reclaimWater?: boolean;
      reclaimBoat?: boolean;
      reclaimBlocks?: boolean;
    };
    waterGuard?: {
      enabled: boolean;
      surfaceOxygenBelow: number;
      seekLand: boolean;
      landSearchRadius: number;
    };
    hazardGuard?: {
      enabled: boolean;
      escapeRadius: number;
      seekWater: boolean;
      useWaterBucket: boolean;
    };
    /** boş kova doldur (MLG reclaim'den bağımsız) */
    bucketScoop?: {
      enabled: boolean;
      scoopWater: boolean;
      scoopLava: boolean;
      radius: number;
      cooldownMs: number;
    };
  };
  chat: { minMessageIntervalMs: number };
  movement: {
    canDig: boolean;
    allowSprint: boolean;
    allowParkour: boolean;
    scaffoldBlocks: string[];
    humanize?: boolean;
    lookTurnDegPerTick?: number;
    maxDrop?: number;
    allowTower?: boolean;
    parkourMaxGap?: 2 | 3 | 4;
    ladderParkour?: boolean;
    parkourSprint?: boolean;
    edgeSafety?: boolean;
    maxSafeDrop?: number;
    bridgeGaps?: boolean;
    preferParkourOverBridge?: boolean;
  };
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
  /** çoklu koruma listesi — ana kişi followPlayer ile takip edilir */
  protectPlayers: string[];
  /** özet: takip edilen korunan veya listenin ilki */
  protectPlayer: string | null;
  protectSettings: {
    range: number;
    /** threats = saldırgan/tehdit · non_whitelist = beyaz liste dışı herkese */
    protectAggro?: "threats" | "non_whitelist";
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
  /** mesaj gövdesi */
  text: string;
  /** rütbe / prefix: "[Admin] " */
  prefix?: string;
  /** " » " / ": " */
  nameSuffix?: string;
  /** tam satır (prefix+isim+mesaj) */
  fullText?: string;
  /** renkli tam satır (ANSI) */
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

export interface BuildPlacedBlock {
  name: string;
  x: number;
  y: number;
  z: number;
  status: "placed" | "skipped" | "failed" | "repaired" | "fixed";
  t: number;
}

export interface BuildRuntime {
  phase:
    | "idle"
    | "preparing"
    | "acquiring"
    | "building"
    | "verifying"
    | "cleanup"
    | "paused"
    | "done"
    | "failed"
    | "cancelled";
  schematicId: string | null;
  schematicName: string | null;
  origin: { x: number; y: number; z: number } | null;
  placed: number;
  total: number;
  skipped: number;
  failed?: number;
  /** hasar sonrası yeniden konan bloklar */
  repaired?: number;
  /** yanlış blok kırılıp düzeltilenler */
  fixedWrong?: number;
  scaffoldsPlaced: number;
  scaffoldsCleared: number;
  /** temizlenemeyen scaffold (dürüst rapor) */
  scaffoldsLeft?: number;
  materials: Array<{ name: string; need: number; have: number; stored?: number; missing: number }>;
  label: string;
  error?: string;
  startedAt: number | null;
  lastBlock?: BuildPlacedBlock | null;
  recentBlocks?: BuildPlacedBlock[];
  transform?: {
    rotateY: 0 | 90 | 180 | 270;
    mirrorX: boolean;
    mirrorZ: boolean;
  };
  placeOrder?: "printer" | "nearby-first";
  collectMissing?: boolean;
  /** creative mod: malzeme ihtiyacı yok */
  creative?: boolean;
  /** watchdog takılma notu */
  stuck?: string | null;
  /** kopunca spawn'da otomatik devam */
  resumePending?: boolean;
  storage?: { containers: number; lastScanAt: number | null };
  /** anlık: Toplanıyor / Kondu / Craft… */
  activity?: string | null;
  activityMaterial?: string | null;
}

export interface BotSnapshot {
  config: BotConfig;
  status: BotStatus;
  runtime: BotRuntimeState;
  chatQueueLength: number;
  tasks: { current: TaskSummary | null; queue: TaskSummary[] };
  inventory: InventorySnapshot | null;
  combat: CombatRuntime;
  build?: BuildRuntime;
}

export interface StateSnapshot {
  servers: ServerProfile[];
  bots: BotSnapshot[];
  waypoints: Record<string, Waypoint[]>;
  supportedVersions: string[];
  rules?: unknown[];
  worldMemory?: { chests: unknown[]; ores: unknown[] };
}

// ---- Faz 18 — MCP / AI agent (server modules/agent aynası) --------------------

export interface McpToolPermissions {
  chat: boolean;
  movement: boolean;
  gather: boolean;
  craft: boolean;
  build: boolean;
  combatAttack: boolean;
  combatDefense: boolean;
  inventory: boolean;
  trust: boolean;
  memory: boolean;
  waypoints: boolean;
}

export interface McpBotSettings {
  agentEnabled: boolean;
  goal: string;
  autopilot: boolean;
}

export interface McpSettings {
  enabled: boolean;
  ollama: {
    enabled: boolean;
    host: string;
    model: string;
    temperature: number;
    numCtx: number;
    keepAlive: string;
  };
  mcpServer: {
    enabled: boolean;
    requireToken: boolean;
    token: string;
  };
  chat: {
    respondInGame: boolean;
    onlyWhenAddressed: boolean;
    respondToWhisper: boolean;
    perPlayerCooldownSec: number;
    maxReplyChars: number;
    personality: string;
    language: "auto" | "tr" | "en";
  };
  trust: {
    enabled: boolean;
    trustedPlayers: string[];
    allowModelToTrust: boolean;
    untrustedPolicy: "ignore" | "chat-only";
  };
  tools: McpToolPermissions;
  /** izinli/kendi sunucular için gerçekçilik-dışı yollar (varsayılan kapalı) */
  utility: {
    enabled: boolean;
    serverCommands: boolean;
    creativeFly: boolean;
    utilityMining: boolean;
  };
  autopilot: {
    intervalSec: number;
    maxToolCallsPerRun: number;
    maxIterationsPerRun: number;
  };
  bots: Record<string, McpBotSettings>;
}

export interface McpBotStatus {
  botId: string;
  username: string;
  status: string;
  agentEnabled: boolean;
  autopilot: boolean;
  goal: string;
  busy: boolean;
  lastRunAt: number;
}

export interface McpStatusPayload {
  settings: McpSettings;
  endpoint: string;
  claudeCommand: string;
  bots: McpBotStatus[];
  tools: Array<{ name: string; category: string; description: string; enabled: boolean }>;
}

export interface McpTranscriptMsg {
  id: number;
  ts: number;
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  source?: "panel" | "game" | "autopilot";
  from?: string;
  toolName?: string;
  isError?: boolean;
}

export interface McpActivity {
  botId: string;
  ts: number;
  kind: "run-start" | "tool-call" | "tool-result" | "reply" | "error" | "run-end";
  text: string;
  toolName?: string;
  source?: string;
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  family?: string;
  parameterSize?: string;
}

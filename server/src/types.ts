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
  /**
   * Öz savunma (boşta / görevdeyken):
   * off = kapalı · mob = hostile · player = saldırgan oyuncu · all = ikisi
   * Proaktif tarama: menzilde zombie vb. gelince savunun veya can düşükse kaç.
   */
  defendMode: "off" | "mob" | "player" | "all";
  /** öz savunma tarama yarıçapı (blok) */
  defendRange: number;
  reach: number;
  cpsCap: number; // 1.8-style cap; 1.9+ uses weapon charge instead
  reactionMsMin: number;
  reactionMsMax: number;
  turnSpeedDegPerTick: number;
  jumpCrit: boolean;
  fleeAtHealth: number;
  chaseDistance: number;
  /**
   * Hedefe kenetlenmişken (saldırı/savunma): menzildeki başka mob / hasar veren oyuncuya
   * ara vuruş — ana hedef değişmez, çok yakın tehdit de hasar alır.
   */
  cleaveNearby?: boolean;
  /** ara vuruş menzili (varsayılan = reach) */
  cleaveRange?: number;
  /** yakın hostile mob'lara ara vuruş */
  cleaveMobs?: boolean;
  /** yakın, bize hasar vermiş / tehdit oyunculara ara vuruş */
  cleavePlayers?: boolean;
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
    /**
     * Koruma saldırı politikası:
     * - threats: korunanın yanındaki saldırgan tehditler (mob + yakın düşman oyuncu)
     * - non_whitelist: menzilde beyaz listede olmayan tüm oyunculara saldır (+ mob opsiyonel)
     */
    protectAggro: "threats" | "non_whitelist";
    retaliateMobs: boolean;
    retaliatePlayers: boolean;
    /** bu isimlere asla saldırmasın (korunanlar zaten eklenir) */
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
  /**
   * Anti-cheat dostu hareket (varsayılan true):
   * yumuşak bakış, sınırlı drop, kule spam kapalı, sprint sadece uzakta, reaksiyon gecikmesi.
   */
  humanize?: boolean;
  /** bakış dönüş hızı °/tick (takip/goto) — düşük = daha insanî, varsayılan 16 */
  lookTurnDegPerTick?: number;
  /** max düşme yüksekliği pathfinder (humanize açıkken) */
  maxDrop?: number;
  /** 1x1 kule (scaffold) — AC riski, varsayılan humanize ile kapalı */
  allowTower?: boolean;
  /** özel gap jump üst sınırı: 2 | 3 | 4 (varsayılan 3) */
  parkourMaxGap?: 2 | 3 | 4;
  /** merdiven/vine parkuru */
  ladderParkour?: boolean;
  /** 3–4 blokta sprint jump */
  parkourSprint?: boolean;
  /**
   * Uçurum güvenliği (varsayılan true):
   * takip/goto sırasında önündeki boşluğu gör → atla / köprü / geri çek.
   * Düştükten sonra MLG ayrı kalır; amaç hiç düşmemek.
   */
  edgeSafety?: boolean;
  /** bu derinlikten fazla drop'a yürüme (varsayılan 2) */
  maxSafeDrop?: number;
  /** kısa boşlukta 1 blok köprü (bilinçli) */
  bridgeGaps?: boolean;
  /** köprüden önce parkour dene */
  preferParkourOverBridge?: boolean;
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
    /** yüksekten düşüş MLG / yumuşak iniş (Faz 15) */
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
    /** suda boğulmama + karaya çık (spawn/otomatik) */
    waterGuard?: {
      enabled: boolean;
      surfaceOxygenBelow: number;
      seekLand: boolean;
      landSearchRadius: number;
    };
    /** ateş / lav / magma kaçış */
    hazardGuard?: {
      enabled: boolean;
      escapeRadius: number;
      seekWater: boolean;
      useWaterBucket: boolean;
    };
    /**
     * Boş kova ile yakındaki su/lav doldurma (opsiyonel).
     * MLG su geri almadan bağımsız — kapalı olsa bile MLG reclaim çalışır.
     */
    bucketScoop?: {
      enabled: boolean;
      scoopWater: boolean;
      scoopLava: boolean;
      radius: number;
      cooldownMs: number;
    };
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
  /** mesaj gövdesi (rütbesiz) */
  text: string;
  /** isimden önce: "[Admin] [VIP] " rütbe/kanal prefix */
  prefix?: string;
  /** isim ile gövde arası: " » " / ": " */
  nameSuffix?: string;
  /** oyunda görünen tam düz satır (prefix+isim+mesaj) */
  fullText?: string;
  /** ANSI-colored full line (from prismarine-chat toAnsi) — rütbe renkleri dahil */
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

/** Faz 14–16 — inşaat runtime (BuildService) */
export interface BuildRuntimeSnapshot {
  phase:
    | "idle"
    | "preparing"
    | "acquiring"
    | "building"
    | "cleanup"
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
  scaffoldsPlaced: number;
  scaffoldsCleared: number;
  materials: Array<{ name: string; need: number; have: number; missing: number }>;
  label: string;
  error?: string;
  startedAt: number | null;
  lastBlock?: {
    name: string;
    x: number;
    y: number;
    z: number;
    status: "placed" | "skipped" | "failed";
    t: number;
  } | null;
  recentBlocks?: Array<{
    name: string;
    x: number;
    y: number;
    z: number;
    status: "placed" | "skipped" | "failed";
    t: number;
  }>;
  transform?: {
    rotateY: 0 | 90 | 180 | 270;
    mirrorX: boolean;
    mirrorZ: boolean;
  };
  placeOrder?: "nearby-first" | "layer-first";
  collectMissing?: boolean;
  /** anlık iş metni: Toplanıyor / Craft / Kondu… */
  activity?: string | null;
  /** şu an işlenen malzeme adı (UI highlight) */
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
  build: BuildRuntimeSnapshot;
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
      // varsayılan: mob — boşta zombie gelince savunsun (panelden kapatılabilir)
      defendMode: "mob",
      defendRange: 12,
      reach: 3.0,
      cpsCap: 8,
      reactionMsMin: 150,
      reactionMsMax: 300,
      turnSpeedDegPerTick: 30,
      jumpCrit: true,
      fleeAtHealth: 6,
      chaseDistance: 24,
      // opt-in: hedefe kilitliyken yanındaki mob / hasar veren oyuncuya da vur
      cleaveNearby: false,
      cleaveRange: 3.0,
      cleaveMobs: true,
      cleavePlayers: true
    },
    survival: {
      autoEat: true,
      eatAtFood: 14,
      foodBlacklist: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "suspicious_stew"],
      fallGuard: {
        enabled: true,
        minDamageHp: 4,
        lethalHealthMargin: 2,
        // taban; gerçek su yerleştirme reach içi dinamik (fallGuard.ts)
        mlgTriggerBlocks: 5.5,
        onlyWhenDangerous: true,
        autoReclaim: true,
        reclaimWater: true,
        reclaimBoat: true,
        reclaimBlocks: true
      },
      waterGuard: {
        enabled: true,
        surfaceOxygenBelow: 14,
        seekLand: true,
        landSearchRadius: 16
      },
      hazardGuard: {
        enabled: true,
        escapeRadius: 12,
        seekWater: true,
        useWaterBucket: true
      },
      bucketScoop: {
        enabled: false,
        scoopWater: true,
        scoopLava: false,
        radius: 3,
        cooldownMs: 2500
      }
    },
    chat: { minMessageIntervalMs: 1500 },
    movement: {
      canDig: true,
      allowSprint: true,
      allowParkour: true,
      scaffoldBlocks: ["dirt", "cobblestone", "netherrack"],
      humanize: true,
      lookTurnDegPerTick: 16,
      maxDrop: 3,
      allowTower: false,
      parkourMaxGap: 3,
      ladderParkour: true,
      parkourSprint: true,
      // kenar "geri çek" takip/goto'yu bozuyordu — varsayılan kapalı; pathfinder maxDrop kullan
      edgeSafety: false,
      maxSafeDrop: 3,
      bridgeGaps: false,
      preferParkourOverBridge: true
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

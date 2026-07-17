import * as crypto from "crypto";
import { loadJson, saveJson } from "../../persistence/store";
import { mergeConfig } from "../../types";

const MCP_FILE = "mcp.json";

/** Tool category toggles — each agent tool belongs to exactly one category. */
export interface McpToolPermissions {
  chat: boolean;
  movement: boolean;
  gather: boolean;
  farm: boolean;
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
  /** this bot is controllable by the agent system (Ollama + MCP endpoint) */
  agentEnabled: boolean;
  /** free-form long-term goal used by autopilot ticks */
  goal: string;
  /** autonomous mode: agent decides next step on its own (interval + task events) */
  autopilot: boolean;
}

export interface McpSettings {
  /** master switch for the whole agent/MCP system */
  enabled: boolean;
  ollama: {
    /** in-process agent (in-game AI) via a local Ollama model */
    enabled: boolean;
    host: string;
    model: string;
    temperature: number;
    /** context window tokens passed to ollama (num_ctx) */
    numCtx: number;
    keepAlive: string;
  };
  mcpServer: {
    /** expose bot tools at /mcp for external MCP clients (Claude Code etc.) */
    enabled: boolean;
    requireToken: boolean;
    token: string;
  };
  chat: {
    /** reply to in-game player chat; off = model only talks via the panel agent chat */
    respondInGame: boolean;
    /** only react when the message mentions the bot name (whispers always count) */
    onlyWhenAddressed: boolean;
    respondToWhisper: boolean;
    perPlayerCooldownSec: number;
    /** MC chat hard limit is 256 — keep replies short */
    maxReplyChars: number;
    /** appended to the system prompt — bot persona */
    personality: string;
    /** reply language: auto = mirror the player's language */
    language: "auto" | "tr" | "en";
  };
  trust: {
    /** when on, only trusted players can give the agent commands in-game */
    enabled: boolean;
    trustedPlayers: string[];
    /** the model may add/remove trusted players itself via trust tools */
    allowModelToTrust: boolean;
    /** what to do with untrusted players: ignore silently or chat without tools */
    untrustedPolicy: "ignore" | "chat-only";
  };
  tools: McpToolPermissions;
  /**
   * Utility / "hile" modu — YALNIZCA kendi sunucun veya otomasyona izin veren
   * sunucular için. Varsayılan KAPALI. Dövüş gerçekçiliği (§9 D1-D8) bundan
   * muaftır ve daima geçerli kalır; bu mod hareket/madencilik/komut tarafını açar.
   */
  utility: {
    enabled: boolean;
    /** /tp /give /gamemode gibi sunucu komutları (server_command aracı; bot OP/izinli olmalı) */
    serverCommands: boolean;
    /** creative modda uçuş (fly_to aracı) */
    creativeFly: boolean;
    /** mine_ore utility kazı modunu kullanabilsin (düz tünel, gerçekçilik-dışı) */
    utilityMining: boolean;
  };
  autopilot: {
    intervalSec: number;
    /** per single agent run (one message → loop) */
    maxToolCallsPerRun: number;
    maxIterationsPerRun: number;
  };
  bots: Record<string, McpBotSettings>;
}

export function defaultMcpSettings(): McpSettings {
  return {
    enabled: false,
    ollama: {
      enabled: false,
      host: "http://127.0.0.1:11434",
      model: "",
      temperature: 0.7,
      numCtx: 8192,
      keepAlive: "5m"
    },
    mcpServer: {
      enabled: true,
      requireToken: false,
      token: crypto.randomBytes(24).toString("hex")
    },
    chat: {
      respondInGame: true,
      onlyWhenAddressed: true,
      respondToWhisper: true,
      perPlayerCooldownSec: 3,
      maxReplyChars: 220,
      personality: "",
      language: "auto"
    },
    trust: {
      enabled: true,
      trustedPlayers: [],
      allowModelToTrust: false,
      untrustedPolicy: "chat-only"
    },
    tools: {
      chat: true,
      movement: true,
      gather: true,
      farm: true,
      craft: true,
      build: true,
      combatAttack: false,
      combatDefense: true,
      inventory: true,
      trust: true,
      memory: true,
      waypoints: true
    },
    utility: {
      enabled: false,
      serverCommands: true,
      creativeFly: true,
      utilityMining: true
    },
    autopilot: {
      intervalSec: 45,
      maxToolCallsPerRun: 16,
      maxIterationsPerRun: 8
    },
    bots: {}
  };
}

export function defaultMcpBotSettings(): McpBotSettings {
  return { agentEnabled: false, goal: "", autopilot: false };
}

export function loadMcpSettings(): McpSettings {
  const loaded = loadJson<Partial<McpSettings>>(MCP_FILE, {});
  const merged = mergeConfig(defaultMcpSettings(), loaded);
  // bots map entries also need default-fill (mergeConfig merges objects recursively,
  // but old files may miss newly added per-bot fields)
  for (const [id, b] of Object.entries(merged.bots ?? {})) {
    merged.bots[id] = mergeConfig(defaultMcpBotSettings(), b ?? {});
  }
  if (!merged.mcpServer.token) merged.mcpServer.token = crypto.randomBytes(24).toString("hex");
  return merged;
}

export function saveMcpSettings(settings: McpSettings): Promise<void> {
  return saveJson(MCP_FILE, settings);
}

/** clamp user-patched numeric fields into safe ranges */
export function sanitizeMcpSettings(s: McpSettings): McpSettings {
  s.chat.perPlayerCooldownSec = clamp(s.chat.perPlayerCooldownSec, 0, 300);
  s.chat.maxReplyChars = clamp(s.chat.maxReplyChars, 40, 256);
  s.ollama.temperature = clampF(s.ollama.temperature, 0, 2);
  s.ollama.numCtx = clamp(s.ollama.numCtx, 1024, 131072);
  s.autopilot.intervalSec = clamp(s.autopilot.intervalSec, 15, 3600);
  s.autopilot.maxToolCallsPerRun = clamp(s.autopilot.maxToolCallsPerRun, 1, 64);
  s.autopilot.maxIterationsPerRun = clamp(s.autopilot.maxIterationsPerRun, 1, 16);
  s.trust.trustedPlayers = [...new Set(s.trust.trustedPlayers.map((p) => String(p).trim()).filter(Boolean))];
  return s;
}

function clamp(v: unknown, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function clampF(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

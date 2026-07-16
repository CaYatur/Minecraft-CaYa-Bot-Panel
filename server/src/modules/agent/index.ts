import * as crypto from "crypto";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../../config/paths";
import type { BotInstance } from "../../core/BotInstance";
import type { BotManager } from "../../core/BotManager";
import { PanelError } from "../../core/errors";
import { mergeConfig } from "../../types";
import { createLogger } from "../../utils/logger";
import { ollamaListModels, ollamaVersion, type OllamaModelInfo } from "./ollama";
import { AgentRuntime, type AgentActivity, type AgentTranscriptMsg } from "./runtime";
import {
  defaultMcpBotSettings,
  loadMcpSettings,
  sanitizeMcpSettings,
  saveMcpSettings,
  type McpBotSettings,
  type McpSettings
} from "./settings";
import { AGENT_TOOLS, isToolEnabled, type AgentHostOps } from "./tools";

const AGENT_MEMORY_DIR = path.join(DATA_DIR, "agent-memory");
const AUTOPILOT_TICK_MS = 5_000;
const EVENT_WAKE_MIN_MS = 8_000;

interface MemoryFile {
  notes: Array<{ ts: number; text: string }>;
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

/**
 * Orchestrates the whole agent/MCP system: settings, per-bot runtimes,
 * in-game chat bridging, trust, persistent memory and the autopilot loop.
 * Emits: "status" (payload) · "activity" (AgentActivity) · "chat" ({botId, msg}).
 */
export class AgentService extends EventEmitter {
  settings: McpSettings;
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly memories = new Map<string, MemoryFile>();
  private readonly cooldowns = new Map<string, number>();
  private readonly instanceListeners = new Map<string, Array<[string, (...a: never[]) => void]>>();
  private autopilotTimer: NodeJS.Timeout | null = null;
  private readonly log = createLogger("agent");

  constructor(
    private readonly manager: BotManager,
    private readonly netInfo: { host: string; port: number }
  ) {
    super();
    this.settings = loadMcpSettings();
    fs.mkdirSync(AGENT_MEMORY_DIR, { recursive: true });
  }

  boot() {
    for (const inst of this.manager.bots.values()) this.attachInstance(inst);
    this.manager.on("botAdded", (inst: BotInstance) => this.attachInstance(inst));
    this.manager.on("botRemoved", (id: string) => this.detachInstance(id));
    this.autopilotTimer = setInterval(() => this.autopilotTick(), AUTOPILOT_TICK_MS);
    this.log.info(
      `Agent/MCP system loaded (enabled=${this.settings.enabled}, ollama=${this.settings.ollama.enabled}, mcp-endpoint=${this.settings.mcpServer.enabled})`
    );
  }

  shutdown() {
    if (this.autopilotTimer) clearInterval(this.autopilotTimer);
    for (const rt of this.runtimes.values()) rt.stopCurrentRun("server shutdown");
  }

  // ---- status / settings -------------------------------------------------------

  get endpoint(): string {
    return `http://${this.netInfo.host}:${this.netInfo.port}/mcp`;
  }

  getStatus(): McpStatusPayload {
    const bots: McpBotStatus[] = [...this.manager.bots.values()].map((inst) => {
      const bs = this.settings.bots[inst.config.id];
      const rt = this.runtimes.get(inst.config.id);
      return {
        botId: inst.config.id,
        username: inst.config.username,
        status: inst.status,
        agentEnabled: bs?.agentEnabled ?? false,
        autopilot: bs?.autopilot ?? false,
        goal: bs?.goal ?? "",
        busy: rt?.busy ?? false,
        lastRunAt: rt?.lastRunAt ?? 0
      };
    });
    const headerFlag = this.settings.mcpServer.requireToken
      ? ` --header "Authorization: Bearer ${this.settings.mcpServer.token}"`
      : "";
    return {
      settings: this.settings,
      endpoint: this.endpoint,
      claudeCommand: `claude mcp add --transport http caya-bot ${this.endpoint}${headerFlag}`,
      bots,
      tools: AGENT_TOOLS.map((t) => ({
        name: t.name,
        category: t.category,
        description: t.description,
        enabled: isToolEnabled(t, this.settings)
      }))
    };
  }

  updateSettings(patch: Partial<McpSettings>): McpSettings {
    // bots map is managed via setBotAgent; guard against accidental wipe
    const { bots: _ignore, ...rest } = patch ?? {};
    this.settings = sanitizeMcpSettings(mergeConfig(this.settings, rest as Partial<McpSettings>));
    void saveMcpSettings(this.settings);
    this.emitStatus();
    return this.settings;
  }

  regenerateToken(): string {
    this.settings.mcpServer.token = crypto.randomBytes(24).toString("hex");
    void saveMcpSettings(this.settings);
    this.emitStatus();
    return this.settings.mcpServer.token;
  }

  setBotAgent(botId: string, patch: Partial<McpBotSettings>): McpBotSettings {
    this.manager.mustGet(botId); // 404 for unknown bots
    const cur = this.settings.bots[botId] ?? defaultMcpBotSettings();
    const next: McpBotSettings = {
      agentEnabled: patch.agentEnabled ?? cur.agentEnabled,
      goal: patch.goal !== undefined ? String(patch.goal).slice(0, 500) : cur.goal,
      autopilot: patch.autopilot ?? cur.autopilot
    };
    this.settings.bots[botId] = next;
    void saveMcpSettings(this.settings);
    this.emitStatus();
    return next;
  }

  private emitStatus() {
    this.emit("status", this.getStatus());
  }

  // ---- ollama helpers ------------------------------------------------------------

  listModels(hostOverride?: string): Promise<OllamaModelInfo[]> {
    return ollamaListModels(hostOverride || this.settings.ollama.host);
  }

  async testOllama(hostOverride?: string): Promise<{ ok: boolean; version: string; models: number; hasSelectedModel: boolean }> {
    const host = hostOverride || this.settings.ollama.host;
    const version = await ollamaVersion(host);
    const models = await ollamaListModels(host).catch(() => []);
    const selected = this.settings.ollama.model;
    return {
      ok: true,
      version,
      models: models.length,
      hasSelectedModel: !selected ? false : models.some((m) => m.name === selected)
    };
  }

  // ---- panel agent chat ------------------------------------------------------------

  async panelMessage(botId: string, text: string): Promise<string> {
    const inst = this.manager.mustGet(botId);
    this.assertAgentUsable(inst);
    const rt = this.ensureRuntime(inst);
    try {
      return await rt.enqueueRun(text, "panel");
    } catch (err) {
      throw new PanelError(err instanceof Error ? err.message : String(err));
    }
  }

  stopRun(botId: string) {
    this.runtimes.get(botId)?.stopCurrentRun();
  }

  resetConversation(botId: string) {
    const inst = this.manager.mustGet(botId);
    this.ensureRuntime(inst).reset();
  }

  getTranscript(botId: string): AgentTranscriptMsg[] {
    const inst = this.manager.mustGet(botId);
    return [...this.ensureRuntime(inst).transcript];
  }

  private assertAgentUsable(inst: BotInstance) {
    if (!this.settings.enabled) throw new PanelError("MCP/Agent system is disabled — enable it in the MCP tab.");
    if (!this.settings.ollama.enabled) {
      throw new PanelError("Ollama agent is disabled — enable Ollama in the MCP tab (the /mcp endpoint for external clients works independently).");
    }
    if (!this.settings.ollama.model) throw new PanelError("No Ollama model selected — pick one in the MCP tab.");
    const bs = this.settings.bots[inst.config.id];
    if (!bs?.agentEnabled) throw new PanelError(`Agent is not enabled for bot "${inst.config.username}" — toggle it in the MCP tab.`);
  }

  // ---- trust + memory (AgentHostOps) -------------------------------------------------

  readonly hostOps: AgentHostOps = {
    trustPlayer: (name: string) => {
      const clean = name.trim();
      if (!clean) return "Player name required.";
      const list = this.settings.trust.trustedPlayers;
      if (list.some((p) => p.toLowerCase() === clean.toLowerCase())) return `${clean} is already trusted.`;
      list.push(clean);
      void saveMcpSettings(this.settings);
      this.emitStatus();
      this.log.success(`Agent trust: ${clean} added to trusted players`);
      return `${clean} is now TRUSTED (they can command the agent in game chat).`;
    },
    untrustPlayer: (name: string) => {
      const clean = name.trim().toLowerCase();
      const before = this.settings.trust.trustedPlayers.length;
      this.settings.trust.trustedPlayers = this.settings.trust.trustedPlayers.filter((p) => p.toLowerCase() !== clean);
      if (this.settings.trust.trustedPlayers.length === before) return `${name} was not in the trusted list.`;
      void saveMcpSettings(this.settings);
      this.emitStatus();
      this.log.info(`Agent trust: ${name} removed from trusted players`);
      return `${name} removed from trusted players.`;
    },
    listTrusted: () => [...this.settings.trust.trustedPlayers],
    remember: (botId: string, text: string) => {
      const mem = this.memoryFor(botId);
      mem.notes.push({ ts: Date.now(), text });
      if (mem.notes.length > 100) mem.notes.splice(0, mem.notes.length - 100);
      this.saveMemory(botId, mem);
      return `Saved to memory (${mem.notes.length} notes total).`;
    },
    recallMemories: (botId: string) => this.memoryFor(botId).notes.map((n, i) => ({ i: i + 1, ts: n.ts, text: n.text })),
    forgetMemory: (botId: string, index: number) => {
      const mem = this.memoryFor(botId);
      if (index < 1 || index > mem.notes.length) return `No memory note #${index}.`;
      const [removed] = mem.notes.splice(index - 1, 1);
      this.saveMemory(botId, mem);
      return `Forgot note #${index}: "${removed?.text ?? ""}"`;
    }
  };

  isTrusted(player: string): boolean {
    if (!this.settings.trust.enabled) return true;
    const p = player.toLowerCase();
    return this.settings.trust.trustedPlayers.some((t) => t.toLowerCase() === p);
  }

  private memoryFor(botId: string): MemoryFile {
    let mem = this.memories.get(botId);
    if (!mem) {
      mem = { notes: [] };
      try {
        const file = path.join(AGENT_MEMORY_DIR, `${sanitizeId(botId)}.json`);
        if (fs.existsSync(file)) {
          const raw = JSON.parse(fs.readFileSync(file, "utf8")) as MemoryFile;
          if (Array.isArray(raw?.notes)) mem = { notes: raw.notes.filter((n) => n && typeof n.text === "string") };
        }
      } catch (err) {
        this.log.warn("Agent memory could not be read", String(err));
      }
      this.memories.set(botId, mem);
    }
    return mem;
  }

  private saveMemory(botId: string, mem: MemoryFile) {
    try {
      const file = path.join(AGENT_MEMORY_DIR, `${sanitizeId(botId)}.json`);
      fs.writeFileSync(file, JSON.stringify(mem, null, 2), "utf8");
    } catch (err) {
      this.log.warn("Agent memory could not be written", String(err));
    }
  }

  // ---- runtimes + instance wiring ------------------------------------------------------

  ensureRuntime(inst: BotInstance): AgentRuntime {
    let rt = this.runtimes.get(inst.config.id);
    if (!rt) {
      rt = new AgentRuntime({
        manager: this.manager,
        inst,
        getSettings: () => this.settings,
        host: this.hostOps,
        onActivity: (a: AgentActivity) => this.emit("activity", a),
        onChat: (m: AgentTranscriptMsg) => this.emit("chat", { botId: inst.config.id, msg: m }),
        log: inst.getLogger()
      });
      this.runtimes.set(inst.config.id, rt);
    }
    return rt;
  }

  private attachInstance(inst: BotInstance) {
    const id = inst.config.id;
    if (this.instanceListeners.has(id)) return;
    const onChat = (entry: { botId: string; kind: string; username?: string; text: string; self?: boolean }) =>
      this.handleGameChat(inst, entry);
    const onTask = (p: { kind: "done" | "failed"; label: string; error?: string; taskType: string }) => {
      if (!this.isAutopilotActive(inst)) return;
      const rt = this.ensureRuntime(inst);
      rt.pushEvent(p.kind === "done" ? `Task finished: ${p.label}` : `Task FAILED: ${p.label}${p.error ? ` (${p.error})` : ""}`);
    };
    const onAttacked = (p: { attacker?: string; source: "mob" | "player" }) => {
      if (!this.isAutopilotActive(inst)) return;
      this.ensureRuntime(inst).pushEvent(`You were attacked by ${p.attacker ?? p.source}.`);
    };
    inst.on("chatParsed", onChat as never);
    inst.on("taskEvent", onTask as never);
    inst.on("attacked", onAttacked as never);
    this.instanceListeners.set(id, [
      ["chatParsed", onChat as never],
      ["taskEvent", onTask as never],
      ["attacked", onAttacked as never]
    ]);
  }

  private detachInstance(botId: string) {
    const inst = this.manager.get(botId);
    const listeners = this.instanceListeners.get(botId);
    if (inst && listeners) for (const [ev, fn] of listeners) inst.off(ev, fn as never);
    this.instanceListeners.delete(botId);
    this.runtimes.get(botId)?.stopCurrentRun("bot removed");
    this.runtimes.delete(botId);
    delete this.settings.bots[botId];
    void saveMcpSettings(this.settings);
  }

  private isAutopilotActive(inst: BotInstance): boolean {
    const bs = this.settings.bots[inst.config.id];
    return Boolean(
      this.settings.enabled && this.settings.ollama.enabled && this.settings.ollama.model && bs?.agentEnabled && bs.autopilot
    );
  }

  // ---- in-game chat bridge --------------------------------------------------------------

  private handleGameChat(
    inst: BotInstance,
    entry: { kind: string; username?: string; text: string; self?: boolean }
  ) {
    const s = this.settings;
    if (!s.enabled || !s.ollama.enabled || !s.ollama.model) return;
    if (entry.self || !entry.username) return;
    if (entry.kind !== "player" && entry.kind !== "whisper") return;
    const bs = s.bots[inst.config.id];
    if (!bs?.agentEnabled) return;
    if (!s.chat.respondInGame) return; // kapalı: model yalnızca panel ajan sohbetinden konuşur
    if (entry.kind === "whisper" && !s.chat.respondToWhisper) return;

    const from = entry.username;
    // never react to our OWN managed bots (two agents would loop forever)
    const isManagedBot = [...this.manager.bots.values()].some(
      (b) => b.config.id !== inst.config.id && b.config.username.toLowerCase() === from.toLowerCase()
    );
    if (isManagedBot) return;

    const text = entry.text.trim();
    if (!text) return;

    // addressed? (whisper her zaman hitaptır)
    if (entry.kind !== "whisper" && s.chat.onlyWhenAddressed) {
      const me = inst.config.username.toLowerCase();
      if (!text.toLowerCase().includes(me)) return;
    }

    const trusted = this.isTrusted(from);
    if (!trusted && s.trust.untrustedPolicy === "ignore") return;

    // per-player cooldown
    const key = `${inst.config.id}:${from.toLowerCase()}`;
    const now = Date.now();
    const last = this.cooldowns.get(key) ?? 0;
    if (now - last < s.chat.perPlayerCooldownSec * 1000) return;
    this.cooldowns.set(key, now);
    if (this.cooldowns.size > 500) {
      for (const [k, t] of this.cooldowns) if (now - t > 600_000) this.cooldowns.delete(k);
    }

    const rt = this.ensureRuntime(inst);
    try {
      rt.enqueueRun(text, "game", {
        from,
        trusted,
        replyWhisperTo: entry.kind === "whisper" ? from : undefined
      })
        .catch((err) => inst.getLogger().warn("Agent in-game reply failed", err instanceof Error ? err.message : String(err)));
    } catch (err) {
      inst.getLogger().warn("Agent busy — in-game message dropped", err instanceof Error ? err.message : String(err));
    }
  }

  // ---- autopilot -----------------------------------------------------------------------

  private autopilotTick() {
    const s = this.settings;
    if (!s.enabled || !s.ollama.enabled || !s.ollama.model) return;
    for (const inst of this.manager.bots.values()) {
      const bs = s.bots[inst.config.id];
      if (!bs?.agentEnabled || !bs.autopilot || !bs.goal.trim()) continue;
      if (inst.status !== "online") continue;
      const rt = this.ensureRuntime(inst);
      if (rt.busy) continue;
      const since = Date.now() - rt.lastRunAt;
      const hasEvents = rt.inbox.length > 0;
      if (hasEvents ? since < EVENT_WAKE_MIN_MS : since < s.autopilot.intervalSec * 1000) continue;
      // uzun görev sürerken boş tik atma — tamamlanma olayı zaten uyandırır
      const taskRunning = inst.tasks.currentSummary?.state === "running";
      const buildPhase = inst.build.getRuntime().phase;
      const buildActive = ["preparing", "acquiring", "building", "verifying", "cleanup"].includes(buildPhase);
      if (!hasEvents && (taskRunning || buildActive)) continue;

      const events = rt.inbox.splice(0);
      const msg = [
        "[AUTOPILOT TICK]",
        `Goal: ${bs.goal.trim()}`,
        events.length ? `Events since last check:\n${events.map((e) => `- ${e}`).join("\n")}` : "Events since last check: (none)",
        'Check the situation with tools if needed, then execute the SINGLE next concrete step toward the goal. If the goal is fully complete, reply exactly "GOAL COMPLETE".'
      ].join("\n");
      try {
        rt.enqueueRun(msg, "autopilot")
          .then((reply) => {
            if (/GOAL[ _-]?COMPLETE/i.test(reply)) {
              const cur = this.settings.bots[inst.config.id];
              if (cur) {
                cur.autopilot = false;
                void saveMcpSettings(this.settings);
                this.emitStatus();
              }
              inst.getLogger().success(`Autopilot goal complete: ${bs.goal.slice(0, 80)}`);
            }
          })
          .catch((err) => inst.getLogger().warn("Autopilot run failed", err instanceof Error ? err.message : String(err)));
      } catch {
        /* queue saturated — try next tick */
      }
    }
  }
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

export { AGENT_TOOLS } from "./tools";
export type { AgentActivity, AgentTranscriptMsg } from "./runtime";
export type { McpSettings } from "./settings";

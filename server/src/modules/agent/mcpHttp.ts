import * as crypto from "crypto";
import { Router, type Request, type Response } from "express";
import type { BotInstance } from "../../core/BotInstance";
import type { BotManager } from "../../core/BotManager";
import { createLogger } from "../../utils/logger";
import type { AgentService } from "./index";
import { allowedTools, executeTool, toolByName, type AgentToolContext } from "./tools";

/**
 * Model Context Protocol server — Streamable HTTP transport (spec 2025-03-26+),
 * implemented directly on Express (JSON-RPC 2.0, no SDK dependency).
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http caya-bot http://127.0.0.1:3001/mcp
 *
 * Only `tools` capability is exposed; every tool call goes through the same
 * registry the in-game Ollama agent uses (realism + permission toggles apply).
 */

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = "2025-03-26";

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const log = createLogger("mcp");

export function createMcpRouter(manager: BotManager, agents: AgentService): Router {
  const r = Router();
  const sessions = new Set<string>();

  r.post("/", async (req: Request, res: Response) => {
    const s = agents.settings;
    if (!s.enabled || !s.mcpServer.enabled) {
      res.status(403).json(rpcError(null, -32000, "MCP endpoint disabled — enable it in the panel's MCP tab."));
      return;
    }
    if (s.mcpServer.requireToken) {
      const auth = String(req.headers.authorization ?? "");
      const ok = auth === `Bearer ${s.mcpServer.token}`;
      if (!ok) {
        res.status(401).json(rpcError(null, -32001, "Unauthorized: missing/invalid bearer token."));
        return;
      }
    }

    const body = req.body as JsonRpcMsg | JsonRpcMsg[] | undefined;
    const messages: JsonRpcMsg[] = Array.isArray(body) ? body : body ? [body] : [];
    if (!messages.length) {
      res.status(400).json(rpcError(null, -32700, "Empty request body"));
      return;
    }

    const responses: unknown[] = [];
    for (const msg of messages) {
      if (!msg || typeof msg.method !== "string") {
        if (msg?.id !== undefined) responses.push(rpcError(msg.id ?? null, -32600, "Invalid request"));
        continue;
      }
      const isNotification = msg.id === undefined || msg.method.startsWith("notifications/");
      if (isNotification) continue; // acknowledged silently
      try {
        const result = await handleRequest(msg, { manager, agents, res, sessions });
        responses.push({ jsonrpc: "2.0", id: msg.id ?? null, result });
      } catch (err) {
        const e = err as { code?: number; message?: string };
        responses.push(rpcError(msg.id ?? null, typeof e.code === "number" ? e.code : -32603, e.message ?? String(err)));
      }
    }

    if (!responses.length) {
      res.status(202).end(); // notifications only
      return;
    }
    res.status(200).json(Array.isArray(body) ? responses : responses[0]);
  });

  // no server-initiated SSE stream — spec allows 405 here
  r.get("/", (_req, res) => {
    res.status(405).json(rpcError(null, -32000, "SSE stream not offered; use POST."));
  });
  r.delete("/", (_req, res) => {
    res.status(200).end();
  });

  return r;
}

interface HandlerCtx {
  manager: BotManager;
  agents: AgentService;
  res: Response;
  sessions: Set<string>;
}

async function handleRequest(msg: JsonRpcMsg, ctx: HandlerCtx): Promise<unknown> {
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const requested = String((params as { protocolVersion?: string }).protocolVersion ?? "");
      const version = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
      const sessionId = crypto.randomUUID();
      ctx.sessions.add(sessionId);
      if (ctx.sessions.size > 200) ctx.sessions.clear();
      ctx.res.setHeader("Mcp-Session-Id", sessionId);
      log.info(`MCP client connected (${(params as { clientInfo?: { name?: string } }).clientInfo?.name ?? "unknown client"})`);
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "caya-bot-panel", title: "Minecraft CaYa Bot Panel", version: "1.0.0" },
        instructions: [
          "Control Minecraft bots managed by the CaYa Bot Panel. Everything executes as REALISTIC in-game actions (no cheats).",
          "Most tools take an optional `bot` argument (bot username). If only one bot has the agent enabled, it is used automatically — call list_bots first to see them.",
          "Long jobs (goto/mine/collect/build/craft) run as async background tasks: start them, then poll get_tasks / get_build_status.",
          "For creative building without schematics use plan_structure (dry-run materials/size) then build_structure with composed shapes; air blocks carve doors/windows."
        ].join(" ")
      };
    }
    case "ping":
      return {};
    case "tools/list": {
      const tools = allowedTools(ctx.agents.settings).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: withBotParam(t.inputSchema, t.needsBot !== false)
      }));
      return { tools };
    }
    case "tools/call": {
      const name = String((params as { name?: string }).name ?? "");
      const args = ((params as { arguments?: Record<string, unknown> }).arguments ?? {}) as Record<string, unknown>;
      const tool = toolByName(name);
      if (!tool) throw { code: -32602, message: `Unknown tool: ${name}` };

      let inst: BotInstance | undefined;
      if (tool.needsBot !== false) {
        inst = resolveBot(ctx.manager, ctx.agents, args.bot);
      } else {
        inst = ctx.manager.bots.values().next().value as BotInstance | undefined;
      }
      const toolCtx: AgentToolContext = {
        manager: ctx.manager,
        // list_bots (needsBot=false) tolerates a missing instance; guarded by needsBot flag
        inst: inst as BotInstance,
        settings: ctx.agents.settings,
        source: "mcp",
        host: ctx.agents.hostOps
      };
      const { bot: _drop, ...cleanArgs } = args;
      const result = await executeTool(toolCtx, name, cleanArgs);
      if (inst) {
        ctx.agents.emit("activity", {
          botId: inst.config.id,
          ts: Date.now(),
          kind: result.isError ? "error" : "tool-result",
          toolName: name,
          text: `[MCP] ${result.text.slice(0, 280)}`,
          source: "panel"
        });
      }
      return { content: [{ type: "text", text: result.text }], isError: result.isError };
    }
    default:
      throw { code: -32601, message: `Method not found: ${msg.method}` };
  }
}

/** add the cross-bot `bot` selector argument to a tool schema (MCP transport only) */
function withBotParam(schema: { type: "object"; properties: Record<string, unknown>; required?: string[] }, add: boolean) {
  if (!add) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      bot: { type: "string", description: "bot username (optional when exactly one bot has the agent enabled — see list_bots)" }
    }
  };
}

function resolveBot(manager: BotManager, agents: AgentService, botArg: unknown): BotInstance {
  const wanted = botArg == null ? "" : String(botArg).trim();
  const all = [...manager.bots.values()];
  if (!all.length) throw { code: -32002, message: "No bots exist on the panel yet — create one in the panel first." };

  if (wanted) {
    const found =
      all.find((b) => b.config.username.toLowerCase() === wanted.toLowerCase()) ??
      all.find((b) => b.config.id === wanted || b.config.id.startsWith(wanted));
    if (!found) {
      throw { code: -32002, message: `Bot "${wanted}" not found. Known bots: ${all.map((b) => b.config.username).join(", ")}` };
    }
    if (!agents.settings.bots[found.config.id]?.agentEnabled) {
      throw { code: -32002, message: `Agent control is disabled for bot "${found.config.username}" — enable it in the panel's MCP tab.` };
    }
    return found;
  }

  const enabled = all.filter((b) => agents.settings.bots[b.config.id]?.agentEnabled);
  if (!enabled.length) {
    throw { code: -32002, message: "No bot has agent control enabled — enable a bot in the panel's MCP tab, or pass `bot`." };
  }
  if (enabled.length === 1) return enabled[0]!;
  const online = enabled.filter((b) => b.status === "online");
  if (online.length === 1) return online[0]!;
  throw {
    code: -32002,
    message: `Multiple agent-enabled bots — pass \`bot\`: ${enabled.map((b) => `${b.config.username}(${b.status})`).join(", ")}`
  };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

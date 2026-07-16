import { Vec3 } from "vec3";
import type { BotInstance } from "../../core/BotInstance";
import type { BotManager } from "../../core/BotManager";
import { PRIORITY } from "../../core/TaskQueue";
import type { BotConfig } from "../../types";
import { addCayaJsonSchematic, listSchematics } from "../build";
import type { SchematicBlock } from "../build/types";
import { runInventoryOp } from "../inventory";
import { runGoto } from "../movement";
import { boundsOf, composeShapes, summarizeMaterials, type ShapeOp } from "./builder";
import type { McpSettings, McpToolPermissions } from "./settings";

/**
 * Shared agent tool registry. The SAME tools are exposed to:
 *  - the local Ollama agent loop (in-game AI), and
 *  - external MCP clients (Claude Code etc.) via the /mcp HTTP endpoint.
 *
 * Every tool goes through the existing task/realism layers (İ2: no cheating,
 * İ5: chat rate limit, İ6: task priorities) — the agent can only do what a
 * human player could do through the panel.
 */

export type ToolCategory = keyof McpToolPermissions | "info";

export interface AgentHostOps {
  trustPlayer(name: string): string;
  untrustPlayer(name: string): string;
  listTrusted(): string[];
  remember(botId: string, text: string): string;
  recallMemories(botId: string): Array<{ i: number; ts: number; text: string }>;
  forgetMemory(botId: string, index: number): string;
}

export interface AgentToolContext {
  manager: BotManager;
  inst: BotInstance;
  settings: McpSettings;
  source: "mcp" | "ollama" | "panel";
  host: AgentHostOps;
}

export interface AgentToolDef {
  name: string;
  description: string;
  category: ToolCategory;
  /** JSON Schema for arguments */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** tool can run without a resolved bot (e.g. list_bots) */
  needsBot?: boolean;
  /**
   * Extra availability gate on top of the category toggle — used by the
   * utility ("izinli sunucu") mode: default OFF, only enabled from the panel.
   */
  gate?: (settings: McpSettings) => boolean;
  execute(ctx: AgentToolContext, args: Record<string, unknown>): Promise<string>;
}

// ---- schema helpers -----------------------------------------------------------

const S = {
  obj(props: Record<string, unknown>, required?: string[]) {
    return { type: "object" as const, properties: props, ...(required && required.length ? { required } : {}) };
  },
  str: (description: string, enumVals?: string[]) => ({ type: "string", description, ...(enumVals ? { enum: enumVals } : {}) }),
  num: (description: string) => ({ type: "number", description }),
  bool: (description: string) => ({ type: "boolean", description }),
  arr: (items: unknown, description: string) => ({ type: "array", items, description })
};

// ---- arg helpers ----------------------------------------------------------------

function aStr(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  const s = v == null ? "" : String(v).trim();
  if (!s) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing argument: ${key}`);
  }
  return s;
}
function aNum(args: Record<string, unknown>, key: string, fallback: number, min?: number, max?: number): number {
  const v = args[key];
  let n = v == null || v === "" ? fallback : Number(v);
  if (!Number.isFinite(n)) n = fallback;
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
}
function aBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null || v === "") return fallback;
  return v === true || v === "true" || v === 1 || v === "1";
}

function requireOnline(ctx: AgentToolContext) {
  if (!ctx.inst.bot || ctx.inst.status !== "online") {
    throw new Error(`Bot "${ctx.inst.config.username}" is not online (status: ${ctx.inst.status}).`);
  }
}

function normName(v: string): string {
  return v.trim().toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
}

function taskReply(task: { id: string; label: string } | null, extra = ""): string {
  if (!task) return `Done.${extra ? " " + extra : ""}`;
  return `Task queued: "${task.label}" (id ${task.id.slice(0, 8)}). It runs async — check progress with get_tasks.${extra ? " " + extra : ""}`;
}

function fmtTime(timeOfDay: number): string {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  const label = t < 1000 ? "sunrise" : t < 12000 ? "day" : t < 13800 ? "sunset" : "night";
  return `${label} (${Math.round(t)})`;
}

// ---- perception / info ----------------------------------------------------------

const listBots: AgentToolDef = {
  name: "list_bots",
  description: "List all bots on the panel with status, server and whether the agent may control them.",
  category: "info",
  needsBot: false,
  inputSchema: S.obj({}),
  async execute(ctx) {
    const lines = [...ctx.manager.bots.values()].map((b) => {
      const srv = ctx.manager.getServer(b.config.serverId);
      const agent = ctx.settings.bots[b.config.id]?.agentEnabled ? "agent:ON" : "agent:off";
      return `- ${b.config.username} [${b.status}] server=${srv?.name ?? "?"} ${agent} (id ${b.config.id.slice(0, 8)})`;
    });
    return lines.length ? lines.join("\n") : "No bots defined yet.";
  }
};

const getStatus: AgentToolDef = {
  name: "get_status",
  description: "Current bot vitals: health, food, XP, position, dimension, time, weather, held item, active task, combat & build state.",
  category: "info",
  inputSchema: S.obj({}),
  async execute(ctx) {
    const i = ctx.inst;
    const r = i.runtime;
    const bot = i.bot;
    const lines: string[] = [];
    lines.push(`Bot ${i.config.username} — status: ${i.status}`);
    lines.push(`Health ${r.health}/20 · Food ${r.food}/20 (sat ${r.foodSaturation}) · XP level ${r.xpLevel}`);
    lines.push(`Position x=${Math.round(r.position.x)} y=${Math.round(r.position.y)} z=${Math.round(r.position.z)} · dimension=${r.dimension}`);
    if (bot && i.status === "online") {
      try {
        lines.push(`Time: ${fmtTime(bot.time?.timeOfDay ?? 0)} · Weather: ${bot.thunderState > 0 ? "thunder" : bot.isRaining ? "rain" : "clear"}`);
      } catch {
        /* time unavailable */
      }
      const held = bot.heldItem ? `${bot.heldItem.name}×${bot.heldItem.count}` : "(empty hand)";
      lines.push(`Held item: ${held}`);
    }
    const cur = i.tasks.currentSummary;
    lines.push(
      cur
        ? `Current task: ${cur.label} [${cur.state}${cur.progress ? ` ${cur.progress.done}/${cur.progress.total}` : ""}] · queued: ${i.tasks.queueSummaries.length}`
        : `Current task: none · queued: ${i.tasks.queueSummaries.length}`
    );
    const c = i.combat.getRuntime();
    lines.push(`Combat: ${c.mode} · self-defense=${c.defendMode} · target=${c.activeTarget ?? "-"}`);
    const b = i.build.getRuntime();
    if (b.phase !== "idle") lines.push(`Build: ${b.phase} ${b.placed}/${b.total} "${b.schematicName ?? ""}"`);
    return lines.join("\n");
  }
};

const getInventory: AgentToolDef = {
  name: "get_inventory",
  description: "List the bot's inventory: item names with total counts, plus equipped armor and held item.",
  category: "info",
  inputSchema: S.obj({}),
  async execute(ctx) {
    requireOnline(ctx);
    const bot = ctx.inst.bot!;
    const totals = new Map<string, number>();
    for (const it of bot.inventory.items()) totals.set(it.name, (totals.get(it.name) ?? 0) + it.count);
    const armorSlots = [5, 6, 7, 8].map((s) => bot.inventory.slots[s]).filter(Boolean);
    const off = bot.inventory.slots[45];
    const lines: string[] = [];
    lines.push(`Items (${totals.size} kinds):`);
    if (totals.size === 0) lines.push("- (inventory empty)");
    for (const [name, count] of [...totals.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- ${name} ×${count}`);
    if (armorSlots.length) lines.push(`Armor: ${armorSlots.map((a) => a!.name).join(", ")}`);
    if (off) lines.push(`Offhand: ${off.name}×${off.count}`);
    lines.push(`Held: ${bot.heldItem ? bot.heldItem.name : "(empty)"}`);
    return lines.join("\n");
  }
};

const lookAround: AgentToolDef = {
  name: "look_around",
  description:
    "Scan surroundings: notable blocks nearby (ores, trees, chests, water/lava...), entities (mobs/animals/item drops), nearby players, light conditions. Use before deciding what to do.",
  category: "info",
  inputSchema: S.obj({ radius: S.num("scan radius in blocks, 4-16 (default 8)") }),
  async execute(ctx, args) {
    requireOnline(ctx);
    const bot = ctx.inst.bot!;
    const radius = Math.round(aNum(args, "radius", 8, 4, 16));
    const pos = bot.entity.position;
    const counts = new Map<string, number>();
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -Math.min(radius, 6); dy <= Math.min(radius, 6); dy++)
        for (let dz = -radius; dz <= radius; dz++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (!b || b.name === "air" || b.name === "cave_air" || b.name === "void_air") continue;
          counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
        }
    const notable = [...counts.entries()].filter(([n]) =>
      /ore|log|chest|barrel|furnace|crafting|water|lava|spawner|bed|door|farmland|wheat|carrot|potato|beetroot|sapling|diamond|ancient_debris/.test(n)
    );
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    const ents = new Map<string, { count: number; nearest: number }>();
    for (const e of Object.values(bot.entities)) {
      if (!e?.position || e === bot.entity) continue;
      const d = e.position.distanceTo(pos);
      if (d > 24) continue;
      const name = String(e.name ?? e.displayName ?? "entity").toLowerCase();
      const cur = ents.get(name) ?? { count: 0, nearest: 999 };
      cur.count++;
      cur.nearest = Math.min(cur.nearest, d);
      ents.set(name, cur);
    }
    const players = ctx.inst.getNearbyPlayers(48);

    const lines: string[] = [];
    lines.push(`Around ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} (r=${radius}):`);
    lines.push(`Common blocks: ${common.map(([n, c]) => `${n}×${c}`).join(", ") || "-"}`);
    if (notable.length) lines.push(`Notable: ${notable.map(([n, c]) => `${n}×${c}`).join(", ")}`);
    lines.push(
      ents.size
        ? `Entities ≤24: ${[...ents.entries()].map(([n, v]) => `${n}×${v.count} (nearest ${v.nearest.toFixed(1)}m)`).join(", ")}`
        : "Entities ≤24: none"
    );
    lines.push(
      players.length
        ? `Players: ${players.map((p) => `${p.username}${p.distance != null ? ` ${p.distance}m` : " (tab)"}`).join(", ")}`
        : "Players: none nearby"
    );
    try {
      lines.push(`Time: ${fmtTime(bot.time?.timeOfDay ?? 0)} · Weather: ${bot.thunderState > 0 ? "thunder" : bot.isRaining ? "rain" : "clear"}`);
    } catch {
      /* */
    }
    return lines.join("\n");
  }
};

const findBlocks: AgentToolDef = {
  name: "find_blocks",
  description: "Find positions of a specific block type near the bot (e.g. iron_ore, oak_log, chest, crafting_table).",
  category: "info",
  inputSchema: S.obj(
    {
      block: S.str("exact minecraft block name, e.g. iron_ore"),
      radius: S.num("search radius 8-128 (default 32)"),
      max: S.num("max results 1-20 (default 8)")
    },
    ["block"]
  ),
  async execute(ctx, args) {
    requireOnline(ctx);
    const bot = ctx.inst.bot!;
    const name = normName(aStr(args, "block"));
    const radius = Math.round(aNum(args, "radius", 32, 8, 128));
    const max = Math.round(aNum(args, "max", 8, 1, 20));
    const reg = bot.registry.blocksByName as Record<string, { id: number } | undefined>;
    const def = reg[name];
    if (!def) {
      const similar = Object.keys(reg).filter((k) => k.includes(name)).slice(0, 6);
      return `Unknown block "${name}".${similar.length ? ` Did you mean: ${similar.join(", ")}` : ""}`;
    }
    const found = bot.findBlocks({ matching: def.id, maxDistance: radius, count: max });
    if (!found.length) return `No ${name} found within ${radius} blocks.`;
    const pos = bot.entity.position;
    return (
      `Found ${found.length}× ${name}:\n` +
      found
        .map((p) => `- ${p.x},${p.y},${p.z} (${p.distanceTo(pos).toFixed(1)}m)`)
        .join("\n")
    );
  }
};

const getRecentChat: AgentToolDef = {
  name: "get_recent_chat",
  description: "Read the last in-game chat messages this bot saw (players + server).",
  category: "info",
  inputSchema: S.obj({ limit: S.num("how many messages, 1-40 (default 15)") }),
  async execute(ctx, args) {
    const limit = Math.round(aNum(args, "limit", 15, 1, 40));
    const list = ctx.inst.chatHistory.slice(-limit);
    if (!list.length) return "No chat seen yet.";
    return list
      .map((e) => {
        const t = new Date(e.ts).toISOString().slice(11, 16);
        if (e.kind === "server") return `[${t}] [server] ${e.text}`;
        return `[${t}] ${e.kind === "whisper" ? "(whisper) " : ""}${e.username}${e.self ? " (me)" : ""}: ${e.text}`;
      })
      .join("\n");
  }
};

const getTasks: AgentToolDef = {
  name: "get_tasks",
  description: "Show the bot's current task, queued tasks and the last few finished/failed tasks.",
  category: "info",
  inputSchema: S.obj({}),
  async execute(ctx) {
    const t = ctx.inst.tasks;
    const cur = t.currentSummary;
    const lines: string[] = [];
    lines.push(
      cur
        ? `Current: ${cur.label} [${cur.state}${cur.progress ? ` ${cur.progress.done}/${cur.progress.total} ${cur.progress.label ?? ""}` : ""}]`
        : "Current: (idle)"
    );
    const q = t.queueSummaries;
    lines.push(q.length ? `Queue (${q.length}): ${q.map((s) => s.label).join(" | ")}` : "Queue: empty");
    const hist = t.historySummaries.slice(-5);
    if (hist.length) {
      lines.push("Recent history:");
      for (const s of hist) lines.push(`- ${s.label} → ${s.state}${s.error ? ` (${s.error})` : ""}`);
    }
    return lines.join("\n");
  }
};

const getBuildStatus: AgentToolDef = {
  name: "get_build_status",
  description: "Progress of the current/last build: phase, placed/total blocks, missing materials, errors. Use to track build_structure jobs.",
  category: "info",
  inputSchema: S.obj({}),
  async execute(ctx) {
    const b = ctx.inst.build.getRuntime();
    if (b.phase === "idle" && !b.schematicName) return "No build has run yet.";
    const missing = b.materials.filter((m) => m.missing > 0);
    const lines = [
      `Build "${b.schematicName ?? "?"}" — phase: ${b.phase}`,
      `Placed ${b.placed}/${b.total} · skipped ${b.skipped} · failed ${b.failed ?? 0} · repaired ${b.repaired ?? 0}`,
      b.activity ? `Now: ${b.activity}${b.activityMaterial ? ` (${b.activityMaterial})` : ""}` : "",
      missing.length ? `Missing materials: ${missing.map((m) => `${m.name}×${m.missing}`).join(", ")}` : "Materials: all available",
      b.stuck ? `STUCK: ${b.stuck}` : "",
      b.error ? `Error: ${b.error}` : ""
    ].filter(Boolean);
    return lines.join("\n");
  }
};

const listWaypoints: AgentToolDef = {
  name: "list_waypoints",
  description: "List saved waypoints (named positions) for this bot's server.",
  category: "info",
  inputSchema: S.obj({}),
  async execute(ctx) {
    const wps = ctx.manager.waypoints.forServer(ctx.inst.config.serverId);
    if (!wps.length) return "No waypoints saved for this server.";
    return wps.map((w) => `- ${w.name}: ${w.x},${w.y},${w.z} (${w.dimension})`).join("\n");
  }
};

const listSchematicsTool: AgentToolDef = {
  name: "list_schematics",
  description: "List the schematic library (uploaded .schem/.litematic files and saved AI designs) — buildable with build_schematic.",
  category: "info",
  needsBot: false,
  inputSchema: S.obj({}),
  async execute() {
    const metas = listSchematics();
    if (!metas.length) return "Schematic library is empty. Design something with build_structure instead.";
    return metas
      .map((m) => `- "${m.name}" — ${m.width}×${m.height}×${m.length}, ${m.blockCount} blocks (${m.format}, id ${m.id.slice(0, 8)})`)
      .join("\n");
  }
};

const listTrusted: AgentToolDef = {
  name: "list_trusted_players",
  description: "List players the agent trusts (they may give it commands in game chat).",
  category: "info",
  inputSchema: S.obj({}),
  async execute(ctx) {
    const list = ctx.host.listTrusted();
    const on = ctx.settings.trust.enabled;
    return `Trust system: ${on ? "ON" : "OFF"}. Trusted players: ${list.length ? list.join(", ") : "(none)"}`;
  }
};

const stopAll: AgentToolDef = {
  name: "stop_all",
  description: "EMERGENCY STOP: cancel all tasks, movement, combat and building immediately. Always available.",
  category: "info",
  inputSchema: S.obj({}),
  async execute(ctx) {
    ctx.manager.cancelAllWork(ctx.inst.config.id, "agent stop_all");
    return "All work stopped (tasks, movement, combat, build).";
  }
};

// ---- chat -----------------------------------------------------------------------

const sendChatTool: AgentToolDef = {
  name: "send_chat",
  description: "Say something in the game chat (rate-limited). Keep it short; max ~220 chars. Slash commands are blocked unless utility mode allows them.",
  category: "chat",
  inputSchema: S.obj({ text: S.str("message to say in chat") }, ["text"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const text = aStr(args, "text").replace(/\s*\n\s*/g, " · ").slice(0, ctx.settings.chat.maxReplyChars);
    // komut kapısı: /msg ailesi hariç slash komutları utility moduna bağlı
    if (text.startsWith("/") && !/^\/(msg|tell|w|r|whisper)\b/i.test(text)) {
      const u = ctx.settings.utility;
      if (!(u.enabled && u.serverCommands)) {
        return "Slash commands are disabled. The owner can enable Utility mode → server commands in the MCP tab (own/permitted servers only). Use plain chat instead.";
      }
    }
    ctx.inst.sendChat(text);
    return `Queued to chat: "${text}"`;
  }
};

const sendWhisper: AgentToolDef = {
  name: "send_whisper",
  description: "Whisper a private message to a player (/msg).",
  category: "chat",
  inputSchema: S.obj({ player: S.str("player name"), text: S.str("message") }, ["player", "text"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const player = aStr(args, "player");
    const text = aStr(args, "text").replace(/\s*\n\s*/g, " · ").slice(0, ctx.settings.chat.maxReplyChars);
    ctx.inst.sendChat(`/msg ${player} ${text}`);
    return `Whisper queued to ${player}.`;
  }
};

const serverCommand: AgentToolDef = {
  name: "server_command",
  description:
    "UTILITY MODE: run a server slash command (/tp, /give, /gamemode, /time, /weather...). Works only if the bot has permission (OP) on the server. Available only when the owner enabled utility mode for this (own/permitted) server.",
  category: "chat",
  gate: (s) => s.utility.enabled && s.utility.serverCommands,
  inputSchema: S.obj({ command: S.str("command without or with leading slash, e.g. 'time set day'") }, ["command"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const cmd = aStr(args, "command").replace(/^\/+/, "").slice(0, 240);
    if (!cmd) throw new Error("Empty command");
    ctx.inst.sendChat(`/${cmd}`);
    return `Command queued: /${cmd} (watch get_recent_chat for the server's response; without OP it will be rejected).`;
  }
};

// ---- movement ---------------------------------------------------------------------

const gotoTool: AgentToolDef = {
  name: "goto",
  description: "Walk to coordinates using pathfinding (jumps, bridges, digs if allowed). Async task.",
  category: "movement",
  inputSchema: S.obj({ x: S.num("target x"), y: S.num("target y"), z: S.num("target z"), range: S.num("stop within N blocks (default 1)") }, ["x", "y", "z"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const task = ctx.inst.enqueueAction({ type: "goto", x: args.x, y: args.y, z: args.z, range: args.range ?? 1 });
    return taskReply(task);
  }
};

const gotoPlayer: AgentToolDef = {
  name: "goto_player",
  description: "Walk to a player (must be in visual range or recently seen). Async task.",
  category: "movement",
  inputSchema: S.obj({ player: S.str("player name"), range: S.num("stop distance (default 2)") }, ["player"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const task = ctx.inst.enqueueAction({ type: "goto-player", player: aStr(args, "player"), range: args.range ?? 2 });
    return taskReply(task);
  }
};

const followPlayer: AgentToolDef = {
  name: "follow_player",
  description: "Continuously follow a player (or stop following with enabled=false).",
  category: "movement",
  inputSchema: S.obj(
    { player: S.str("player name"), distance: S.num("follow distance 1-16 (default 3)"), enabled: S.bool("false to stop following") },
    ["player"]
  ),
  async execute(ctx, args) {
    requireOnline(ctx);
    const enabled = aBool(args, "enabled", true);
    ctx.inst.enqueueAction({ type: "social-follow", player: aStr(args, "player"), enabled, distance: args.distance });
    return enabled ? `Now following ${aStr(args, "player")}.` : "Stopped following.";
  }
};

const gotoWaypoint: AgentToolDef = {
  name: "goto_waypoint",
  description: "Walk to a saved waypoint by name (see list_waypoints).",
  category: "movement",
  inputSchema: S.obj({ name: S.str("waypoint name") }, ["name"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const name = aStr(args, "name").toLowerCase();
    const wp = ctx.manager.waypoints.forServer(ctx.inst.config.serverId).find((w) => w.name.toLowerCase() === name);
    if (!wp) return `Waypoint "${name}" not found. Use list_waypoints.`;
    if (ctx.inst.runtime.dimension !== wp.dimension) {
      return `Waypoint is in ${wp.dimension} but bot is in ${ctx.inst.runtime.dimension} — change dimension first.`;
    }
    const task = ctx.inst.enqueueAction({ type: "goto", x: wp.x, y: wp.y, z: wp.z, range: 2, label: `waypoint: ${wp.name}` });
    return taskReply(task);
  }
};

const interactBlock: AgentToolDef = {
  name: "interact_block",
  description: "Right-click / activate a block within reach (~4 blocks): open doors, press buttons, flip levers, ring bells. Walk there first with goto if too far.",
  category: "movement",
  inputSchema: S.obj({ x: S.num("block x"), y: S.num("block y"), z: S.num("block z") }, ["x", "y", "z"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const bot = ctx.inst.bot!;
    const v = new Vec3(Math.floor(Number(args.x)), Math.floor(Number(args.y)), Math.floor(Number(args.z)));
    const block = bot.blockAt(v);
    if (!block || block.name === "air") return `No interactable block at ${v.x},${v.y},${v.z}.`;
    const dist = bot.entity.position.distanceTo(v.offset(0.5, 0.5, 0.5));
    if (dist > 4.2) return `Block is ${dist.toFixed(1)}m away — walk closer first (goto ${v.x} ${v.y} ${v.z}).`;
    await bot.activateBlock(block);
    return `Activated ${block.name} at ${v.x},${v.y},${v.z}.`;
  }
};

const flyTo: AgentToolDef = {
  name: "fly_to",
  description:
    "UTILITY MODE: fly directly to coordinates using creative-mode flight. Requires the bot to be in creative gamemode AND utility mode enabled in the panel. Async task.",
  category: "movement",
  gate: (s) => s.utility.enabled && s.utility.creativeFly,
  inputSchema: S.obj({ x: S.num("target x"), y: S.num("target y"), z: S.num("target z") }, ["x", "y", "z"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const x = Math.floor(Number(args.x));
    const y = Math.floor(Number(args.y));
    const z = Math.floor(Number(args.z));
    if (![x, y, z].every(Number.isFinite)) throw new Error("x/y/z required");
    const gm = String(ctx.inst.bot!.game?.gameMode ?? "");
    if (!gm.includes("creative")) {
      return `fly_to needs creative gamemode (current: ${gm || "unknown"}). Ask the owner or use goto for walking.`;
    }
    const inst = ctx.inst;
    const task = inst.tasks.enqueue(
      { type: "fly-to", label: `fly: ${x} ${y} ${z}`, priority: PRIORITY.USER, params: { x, y, z } },
      () => async (token) => {
        const bot = inst.bot;
        if (!bot || inst.status !== "online") throw new Error("Bot offline");
        if (!String(bot.game?.gameMode ?? "").includes("creative")) throw new Error("Creative gamemode required");
        const flight = bot.creative.flyTo(new Vec3(x, y, z));
        const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Flight timed out (60s)")), 60_000));
        try {
          await Promise.race([flight, timeout]);
        } finally {
          if (token.cancelled) {
            try {
              bot.creative.stopFlying();
            } catch {
              /* */
            }
          }
        }
      }
    );
    return taskReply(task);
  }
};

// ---- gathering ----------------------------------------------------------------------

const collectWood: AgentToolDef = {
  name: "collect_wood",
  description: "Chop trees until the bot has N logs in inventory (searches in expanding rings if none nearby, replants saplings). Async task.",
  category: "gather",
  inputSchema: S.obj({ count: S.num("target log count (default 16)"), log_type: S.str("optional log type, e.g. oak_log") }),
  async execute(ctx, args) {
    requireOnline(ctx);
    const task = ctx.inst.enqueueAction({
      type: "collect-wood",
      count: aNum(args, "count", 16, 1, 512),
      logType: args.log_type ? normName(String(args.log_type)) : undefined
    });
    return taskReply(task);
  }
};

const mineOre: AgentToolDef = {
  name: "mine_ore",
  description:
    "Mine an ore/block until the bot has N of it. Default legit mode (proper tool, realistic, avoids lava). utility=true uses fast non-realistic tunneling — only works when the panel's utility mode allows it. e.g. ore=iron, coal, copper, diamond. Async task.",
  category: "gather",
  inputSchema: S.obj(
    {
      ore: S.str("ore name, e.g. iron / coal / diamond / stone"),
      count: S.num("target count (default 8)"),
      utility: S.bool("fast non-realistic mining (needs utility mode enabled in panel)")
    },
    ["ore"]
  ),
  async execute(ctx, args) {
    requireOnline(ctx);
    const wantUtility = aBool(args, "utility", false);
    const u = ctx.settings.utility;
    const utilityAllowed = u.enabled && u.utilityMining;
    const mode = wantUtility && utilityAllowed ? "utility" : "legit";
    const task = ctx.inst.enqueueAction({
      type: "mine",
      ore: normName(aStr(args, "ore")),
      count: aNum(args, "count", 8, 1, 256),
      mode
    });
    const note = wantUtility && !utilityAllowed ? "Utility mining is disabled in the panel — fell back to legit mode." : `Mode: ${mode}.`;
    return taskReply(task, note);
  }
};

const collectBlocks: AgentToolDef = {
  name: "collect_blocks",
  description: "Collect a specific block type (dig + pick up) until the bot has N, searching in expanding rings. e.g. sand, dirt, cobblestone. Async task.",
  category: "gather",
  inputSchema: S.obj({ block: S.str("block/item name"), count: S.num("target count (default 8)") }, ["block"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const task = ctx.inst.enqueueAction({ type: "collect", item: normName(aStr(args, "block")), count: aNum(args, "count", 8, 1, 512) });
    return taskReply(task);
  }
};

const collectDrops: AgentToolDef = {
  name: "collect_drops",
  description: "Pick up item drops lying on the ground nearby. Async task.",
  category: "gather",
  inputSchema: S.obj({ radius: S.num("search radius (default 16)"), filter: S.str("optional item name filter") }),
  async execute(ctx, args) {
    requireOnline(ctx);
    const task = ctx.inst.enqueueAction({
      type: "collect-drops",
      radius: aNum(args, "radius", 16, 4, 64),
      filter: args.filter ? normName(String(args.filter)) : undefined
    });
    return taskReply(task);
  }
};

const huntAnimals: AgentToolDef = {
  name: "hunt_animals",
  description: "Hunt nearby animals for food (realistic combat rules). Async task.",
  category: "gather",
  inputSchema: S.obj({ radius: S.num("search radius (default 32)") }),
  async execute(ctx, args) {
    requireOnline(ctx);
    const task = ctx.inst.enqueueAction({ type: "hunt", radius: aNum(args, "radius", 32, 8, 96) });
    return taskReply(task);
  }
};

// ---- craft / survival ------------------------------------------------------------------

const craftItem: AgentToolDef = {
  name: "craft_item",
  description: "Craft an item; automatically gathers/crafts missing ingredients when possible (crafting table, furnace). Async task.",
  category: "craft",
  inputSchema: S.obj({ item: S.str("item name, e.g. stone_pickaxe"), count: S.num("how many (default 1)") }, ["item"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const task = ctx.inst.enqueueAction({ type: "craft", item: normName(aStr(args, "item")), count: aNum(args, "count", 1, 1, 64) });
    return taskReply(task);
  }
};

const previewCraftPlan: AgentToolDef = {
  name: "preview_craft_plan",
  description: "Show the step-by-step crafting plan (needed ingredients / sub-crafts) WITHOUT executing it.",
  category: "craft",
  inputSchema: S.obj({ item: S.str("item name"), count: S.num("how many (default 1)") }, ["item"]),
  async execute(ctx, args) {
    const plan = ctx.inst.craft.previewPlan(normName(aStr(args, "item")), Math.round(aNum(args, "count", 1, 1, 64)));
    if (!plan.length) return "No plan (item may be unknown or already trivial).";
    return plan.map((s, i) => `${i + 1}. ${(s as { label?: string }).label ?? JSON.stringify(s)}`).join("\n");
  }
};

const cookFood: AgentToolDef = {
  name: "cook_food",
  description: "Cook raw food in a furnace (finds/places furnace, manages fuel). Async task.",
  category: "craft",
  inputSchema: S.obj({}),
  async execute(ctx) {
    requireOnline(ctx);
    return taskReply(ctx.inst.enqueueAction({ type: "cook" }));
  }
};

const eatNow: AgentToolDef = {
  name: "eat_now",
  description: "Eat the best food in inventory right now.",
  category: "craft",
  inputSchema: S.obj({}),
  async execute(ctx) {
    requireOnline(ctx);
    return taskReply(ctx.inst.enqueueAction({ type: "eat" }));
  }
};

const sleepInBed: AgentToolDef = {
  name: "sleep_in_bed",
  description: "Find a bed nearby (≤32 blocks), walk to it and sleep. Only works at night or during thunderstorms; wakes automatically in the morning. Async task.",
  category: "craft",
  inputSchema: S.obj({}),
  async execute(ctx) {
    requireOnline(ctx);
    const inst = ctx.inst;
    const task = inst.tasks.enqueue(
      { type: "sleep", label: "sleep in bed", priority: PRIORITY.USER, params: {} },
      () => async (token, report) => {
        const bot = inst.bot;
        if (!bot || inst.status !== "online") throw new Error("Bot offline");
        report({ done: 0, total: 2, label: "looking for bed" });
        const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 32 });
        if (!bed) throw new Error("No bed within 32 blocks — craft/place one first (white_bed).");
        await runGoto(inst, bed.position.x, bed.position.y, bed.position.z, 2, token, report);
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        report({ done: 1, total: 2, label: "sleeping" });
        await bot.sleep(bed);
        report({ done: 2, total: 2, label: "zzz" });
      }
    );
    return taskReply(task, "Fails if it is daytime or monsters are nearby (vanilla rules).");
  }
};

const wakeUp: AgentToolDef = {
  name: "wake_up",
  description: "Get out of bed immediately (if sleeping).",
  category: "craft",
  inputSchema: S.obj({}),
  async execute(ctx) {
    requireOnline(ctx);
    const bot = ctx.inst.bot!;
    if (!bot.isSleeping) return "Not sleeping.";
    await bot.wake();
    return "Woke up.";
  }
};

// ---- inventory / storage ------------------------------------------------------------------

const depositItems: AgentToolDef = {
  name: "deposit_items",
  description: "Walk to the nearest chest and deposit inventory items (optionally only names containing filter). Async task.",
  category: "inventory",
  inputSchema: S.obj({ filter: S.str("optional name filter, e.g. cobblestone") }),
  async execute(ctx, args) {
    requireOnline(ctx);
    return taskReply(ctx.inst.enqueueAction({ type: "deposit", filter: args.filter ? normName(String(args.filter)) : "" }));
  }
};

const withdrawItems: AgentToolDef = {
  name: "withdraw_items",
  description: "Take an item from the nearest chest. Async task.",
  category: "inventory",
  inputSchema: S.obj({ item: S.str("item name"), count: S.num("how many (default 1)") }, ["item"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    return taskReply(ctx.inst.enqueueAction({ type: "withdraw", item: normName(aStr(args, "item")), count: aNum(args, "count", 1, 1, 2304) }));
  }
};

const giveItem: AgentToolDef = {
  name: "give_item_to_player",
  description: "Bring an item from inventory to a player and drop it at their feet. Async task.",
  category: "inventory",
  inputSchema: S.obj({ item: S.str("item name"), count: S.num("how many"), player: S.str("receiver player") }, ["item", "player"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    return taskReply(
      ctx.inst.enqueueAction({
        type: "fetch",
        item: normName(aStr(args, "item")),
        count: aNum(args, "count", 1, 1, 2304),
        player: aStr(args, "player")
      })
    );
  }
};

const dropItems: AgentToolDef = {
  name: "drop_items",
  description: "Drop items on the ground where the bot stands (count or all). Respects the protected keep-list.",
  category: "inventory",
  inputSchema: S.obj({ item: S.str("item name"), count: S.num("how many (ignored when all=true)"), all: S.bool("drop every matching item") }, ["item"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    return taskReply(
      ctx.inst.enqueueAction({
        type: "drop-items",
        item: normName(aStr(args, "item")),
        count: aNum(args, "count", 1, 0, 2304),
        dropMode: aBool(args, "all", false) ? "all" : "count"
      })
    );
  }
};

const equipItem: AgentToolDef = {
  name: "equip_item",
  description: "Equip armor/shield or hold a tool/weapon/block in hand, by item name from inventory.",
  category: "inventory",
  inputSchema: S.obj({ item: S.str("item name in inventory") }, ["item"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const bot = ctx.inst.bot!;
    const name = normName(aStr(args, "item"));
    const stack = bot.inventory.items().find((i) => i.name === name) ?? bot.inventory.items().find((i) => i.name.includes(name));
    if (!stack) return `No "${name}" in inventory.`;
    const isEquip = /helmet|chestplate|leggings|boots|shield|elytra|_head|skull|carved_pumpkin/.test(stack.name);
    await runInventoryOp(ctx.inst, { op: isEquip ? "equip" : "hold", slot: stack.slot } as never);
    return `${stack.name} ${isEquip ? "equipped" : "now held in hand"}.`;
  }
};

// ---- build (creative, schematic-free) -----------------------------------------------------

const SHAPES_DESC =
  'Shapes are placed into a voxel grid in order; block:"air" CARVES previously placed cells (doors, windows, interiors). ' +
  "Coordinates are RELATIVE to origin: dx=east, dy=up, dz=south. Shapes: " +
  "box{width,height,length}, hollow_box{width,height,length} (walls+floor+roof, hollow inside), floor{width,length}, " +
  "wall{axis:x|z,width|length,height}, pillar{height}, line{to:{dx,dy,dz}}, cylinder{radius,height,hollow?}, " +
  "ring{radius}, sphere{radius,hollow?}, dome{radius,hollow?}, pyramid{width|radius,height,hollow?}, cone{radius,height}, " +
  "stairs{axis,direction:1|-1,height,width}, roof_gable{axis,width,length}, blocks{cells:[{dx,dy,dz,block}]}. " +
  'Each shape: {shape, block, at:{dx,dy,dz}, ...params}. Example house: [{"shape":"hollow_box","block":"oak_planks","width":7,"height":5,"length":7},' +
  '{"shape":"blocks","block":"air","cells":[{"dx":3,"dy":1,"dz":0},{"dx":3,"dy":2,"dz":0}]},{"shape":"roof_gable","block":"oak_stairs","at":{"dy":5},"width":9,"length":9,"axis":"x"}]';

const shapesSchema = S.arr(
  {
    type: "object",
    properties: {
      shape: S.str("shape kind", [
        "box",
        "hollow_box",
        "floor",
        "wall",
        "pillar",
        "line",
        "cylinder",
        "sphere",
        "dome",
        "pyramid",
        "cone",
        "stairs",
        "roof_gable",
        "ring",
        "blocks"
      ]),
      block: S.str('minecraft block name; "air" carves'),
      at: S.obj({ dx: S.num("offset east"), dy: S.num("offset up"), dz: S.num("offset south") }),
      width: S.num("x size"),
      height: S.num("y size"),
      length: S.num("z size"),
      radius: S.num("radius for radial shapes"),
      hollow: S.bool("hollow variant"),
      axis: S.str("orientation axis", ["x", "z"]),
      direction: S.num("stairs direction 1 or -1"),
      to: S.obj({ dx: S.num(""), dy: S.num(""), dz: S.num("") }),
      cells: S.arr(S.obj({ dx: S.num(""), dy: S.num(""), dz: S.num(""), block: S.str("cell block (optional)") }), "raw voxels")
    },
    required: ["shape"]
  },
  "ordered shape list — later shapes overwrite earlier cells"
);

function parseShapes(args: Record<string, unknown>): SchematicBlock[] {
  let shapes = args.shapes as ShapeOp[] | string | undefined;
  if (typeof shapes === "string") {
    try {
      shapes = JSON.parse(shapes) as ShapeOp[];
    } catch {
      throw new Error("shapes must be a JSON array");
    }
  }
  if (!Array.isArray(shapes) || !shapes.length) throw new Error("shapes array required");
  return composeShapes(shapes);
}

const planStructure: AgentToolDef = {
  name: "plan_structure",
  description: `Dry-run a creative build design: computes size, block count and the material list WITHOUT building. Use this to iterate on a design and check materials first. ${SHAPES_DESC}`,
  category: "build",
  inputSchema: S.obj({ shapes: shapesSchema }, ["shapes"]),
  async execute(ctx, args) {
    const blocks = parseShapes(args);
    const b = boundsOf(blocks);
    const mats = summarizeMaterials(blocks);
    const have = new Map<string, number>();
    if (ctx.inst.bot && ctx.inst.status === "online") {
      for (const it of ctx.inst.bot.inventory.items()) have.set(it.name, (have.get(it.name) ?? 0) + it.count);
    }
    return [
      `Plan OK: ${blocks.length} blocks, size ${b.w}×${b.h}×${b.l} (W×H×L).`,
      "Materials:",
      ...mats.map((m) => `- ${m.name} ×${m.count}${have.size ? ` (in inventory: ${have.get(m.name) ?? 0})` : ""}`),
      "Call build_structure with the same shapes to build it."
    ].join("\n");
  }
};

const buildStructure: AgentToolDef = {
  name: "build_structure",
  description:
    `Build YOUR OWN design (no schematic file needed): compose it from shapes, then the bot builds it block by block with realistic placement, scaffolding and progress tracking. Design is saved to the schematic library as "AI · name". Track with get_build_status. ${SHAPES_DESC}`,
  category: "build",
  inputSchema: S.obj(
    {
      name: S.str("short name for the structure"),
      shapes: shapesSchema,
      origin_mode: S.str("where to anchor the build (default here = bot position)", ["here", "coords", "player"]),
      x: S.num("origin x (origin_mode=coords)"),
      y: S.num("origin y (origin_mode=coords)"),
      z: S.num("origin z (origin_mode=coords)"),
      player: S.str("anchor player name (origin_mode=player)"),
      collect_missing: S.bool("gather/craft missing materials automatically (default true)"),
      allow_partial: S.bool("start even if materials are missing (default true)")
    },
    ["name", "shapes"]
  ),
  async execute(ctx, args) {
    requireOnline(ctx);
    const blocks = parseShapes(args);
    const name = aStr(args, "name").slice(0, 48);
    const meta = addCayaJsonSchematic({ name: `AI · ${name}`, blocks, note: "Agent (MCP) creative build" });
    const b = boundsOf(blocks);
    const mats = summarizeMaterials(blocks).slice(0, 12);
    const task = ctx.inst.enqueueAction({
      type: "build-schematic",
      schematicId: meta.id,
      originMode: aStr(args, "origin_mode", "here"),
      x: args.x,
      y: args.y,
      z: args.z,
      player: args.player,
      collectMissing: aBool(args, "collect_missing", true),
      allowPartial: aBool(args, "allow_partial", true)
    });
    return [
      `Build started: "${name}" — ${blocks.length} blocks, ${b.w}×${b.h}×${b.l}.`,
      `Materials: ${mats.map((m) => `${m.name}×${m.count}`).join(", ")}`,
      taskReply(task, "Poll get_build_status for stage-by-stage progress.")
    ].join("\n");
  }
};

const buildSchematic: AgentToolDef = {
  name: "build_schematic",
  description:
    "Build an EXISTING schematic from the library by name or id (see list_schematics). Uses the full build engine (materials, scaffolds, repair). Track with get_build_status.",
  category: "build",
  inputSchema: S.obj(
    {
      schematic: S.str("schematic name or id (from list_schematics)"),
      origin_mode: S.str("anchor (default here = bot position)", ["here", "coords", "player"]),
      x: S.num("origin x (coords)"),
      y: S.num("origin y (coords)"),
      z: S.num("origin z (coords)"),
      player: S.str("anchor player (origin_mode=player)"),
      rotate_y: S.num("rotate 0/90/180/270"),
      collect_missing: S.bool("gather/craft missing materials (default true)"),
      allow_partial: S.bool("start even if materials missing (default true)")
    },
    ["schematic"]
  ),
  async execute(ctx, args) {
    requireOnline(ctx);
    const q = aStr(args, "schematic").toLowerCase();
    const metas = listSchematics();
    const meta =
      metas.find((m) => m.id === q || m.id.startsWith(q)) ??
      metas.find((m) => m.name.toLowerCase() === q) ??
      metas.find((m) => m.name.toLowerCase().includes(q));
    if (!meta) return `Schematic "${q}" not found. Use list_schematics.`;
    const task = ctx.inst.enqueueAction({
      type: "build-schematic",
      schematicId: meta.id,
      originMode: aStr(args, "origin_mode", "here"),
      x: args.x,
      y: args.y,
      z: args.z,
      player: args.player,
      rotateY: args.rotate_y != null ? Number(args.rotate_y) : 0,
      collectMissing: aBool(args, "collect_missing", true),
      allowPartial: aBool(args, "allow_partial", true)
    });
    return taskReply(task, `Building "${meta.name}" (${meta.blockCount} blocks). Poll get_build_status.`);
  }
};

const stopBuild: AgentToolDef = {
  name: "stop_build",
  description: "Stop the current build (scaffolds are cleaned up).",
  category: "build",
  inputSchema: S.obj({}),
  async execute(ctx) {
    ctx.inst.enqueueAction({ type: "stop-build" });
    return "Build stop requested.";
  }
};

// ---- combat -------------------------------------------------------------------------------

const attackPlayer: AgentToolDef = {
  name: "attack_player",
  description: "Attack a player (realistic combat: look-before-hit, reach 3, line of sight, human-like timing). Async task.",
  category: "combatAttack",
  inputSchema: S.obj({ player: S.str("player name") }, ["player"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    return taskReply(ctx.inst.enqueueAction({ type: "attack", player: aStr(args, "player") }));
  }
};

const clearMobs: AgentToolDef = {
  name: "clear_hostile_mobs",
  description: "Fight hostile mobs (zombies, skeletons...) within a radius. Keeps safe distance from creepers. Async task.",
  category: "combatAttack",
  inputSchema: S.obj({ radius: S.num("radius (default 16)") }),
  async execute(ctx, args) {
    requireOnline(ctx);
    return taskReply(ctx.inst.enqueueAction({ type: "clear-mobs", radius: aNum(args, "radius", 16, 4, 48) }));
  }
};

const setSelfDefense: AgentToolDef = {
  name: "set_self_defense",
  description: "Configure automatic self-defense: off / mob / player / all. The bot then defends itself when threatened, even while doing other tasks.",
  category: "combatDefense",
  inputSchema: S.obj({ mode: S.str("defense mode", ["off", "mob", "player", "all"]), range: S.num("scan range 4-32 (default 12)") }, ["mode"]),
  async execute(ctx, args) {
    const mode = aStr(args, "mode");
    if (!["off", "mob", "player", "all"].includes(mode)) throw new Error("mode must be off|mob|player|all");
    const patch = { combat: { defendMode: mode, defendRange: Math.round(aNum(args, "range", ctx.inst.config.combat.defendRange, 4, 32)) } };
    ctx.manager.updateBotConfig(ctx.inst.config.id, patch as unknown as Partial<BotConfig>);
    return `Self-defense set to "${mode}" (range ${patch.combat.defendRange}).`;
  }
};

const protectPlayer: AgentToolDef = {
  name: "protect_player",
  description: "Bodyguard mode: follow a player and fight threats near them (enabled=false to stop).",
  category: "combatDefense",
  inputSchema: S.obj({ player: S.str("player to protect"), enabled: S.bool("false to stop protecting"), range: S.num("threat scan radius (default 10)") }, ["player"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const enabled = aBool(args, "enabled", true);
    ctx.inst.enqueueAction({ type: "social-protect", player: aStr(args, "player"), enabled, range: args.range });
    return enabled ? `Now protecting ${aStr(args, "player")}.` : "Protection stopped.";
  }
};

const fleeTool: AgentToolDef = {
  name: "flee",
  description: "Run away from the current threat/position to safety. Async task.",
  category: "combatDefense",
  inputSchema: S.obj({}),
  async execute(ctx) {
    requireOnline(ctx);
    return taskReply(ctx.inst.enqueueAction({ type: "flee" }));
  }
};

const stopCombat: AgentToolDef = {
  name: "stop_combat",
  description: "Stop all fighting immediately.",
  category: "combatDefense",
  inputSchema: S.obj({}),
  async execute(ctx) {
    ctx.inst.enqueueAction({ type: "stop-combat" });
    return "Combat stopped.";
  }
};

// ---- trust ---------------------------------------------------------------------------------

const trustPlayerTool: AgentToolDef = {
  name: "trust_player",
  description: "Add a player to the trusted list (they can then command the agent in game). Only works if the panel allows the model to manage trust.",
  category: "trust",
  inputSchema: S.obj({ player: S.str("player name") }, ["player"]),
  async execute(ctx, args) {
    if (!ctx.settings.trust.allowModelToTrust && ctx.source === "ollama") {
      return "Not allowed: the panel setting 'model may manage trust' is OFF. Ask the owner to add the player from the MCP tab.";
    }
    return ctx.host.trustPlayer(aStr(args, "player"));
  }
};

const untrustPlayerTool: AgentToolDef = {
  name: "untrust_player",
  description: "Remove a player from the trusted list.",
  category: "trust",
  inputSchema: S.obj({ player: S.str("player name") }, ["player"]),
  async execute(ctx, args) {
    if (!ctx.settings.trust.allowModelToTrust && ctx.source === "ollama") {
      return "Not allowed: the panel setting 'model may manage trust' is OFF.";
    }
    return ctx.host.untrustPlayer(aStr(args, "player"));
  }
};

// ---- memory --------------------------------------------------------------------------------

const rememberTool: AgentToolDef = {
  name: "remember",
  description: "Save a persistent note to the bot's long-term memory (survives restarts). e.g. base location, who owns what, promises made.",
  category: "memory",
  inputSchema: S.obj({ text: S.str("the fact to remember (short)") }, ["text"]),
  async execute(ctx, args) {
    return ctx.host.remember(ctx.inst.config.id, aStr(args, "text").slice(0, 400));
  }
};

const recallMemoriesTool: AgentToolDef = {
  name: "recall_memories",
  description: "Read all saved long-term memory notes for this bot.",
  category: "memory",
  inputSchema: S.obj({}),
  async execute(ctx) {
    const notes = ctx.host.recallMemories(ctx.inst.config.id);
    if (!notes.length) return "Memory is empty.";
    return notes.map((n) => `${n.i}. [${new Date(n.ts).toISOString().slice(0, 10)}] ${n.text}`).join("\n");
  }
};

const forgetMemoryTool: AgentToolDef = {
  name: "forget_memory",
  description: "Delete one memory note by its number (see recall_memories).",
  category: "memory",
  inputSchema: S.obj({ index: S.num("note number") }, ["index"]),
  async execute(ctx, args) {
    return ctx.host.forgetMemory(ctx.inst.config.id, Math.round(aNum(args, "index", -1)));
  }
};

// ---- waypoints ------------------------------------------------------------------------------

const saveWaypointHere: AgentToolDef = {
  name: "save_waypoint_here",
  description: "Save the bot's current position as a named waypoint.",
  category: "waypoints",
  inputSchema: S.obj({ name: S.str("waypoint name") }, ["name"]),
  async execute(ctx, args) {
    requireOnline(ctx);
    const wp = ctx.manager.createWaypoint(ctx.inst.config.serverId, {
      name: aStr(args, "name").slice(0, 32),
      x: ctx.inst.runtime.position.x,
      y: ctx.inst.runtime.position.y,
      z: ctx.inst.runtime.position.z,
      dimension: ctx.inst.runtime.dimension,
      note: "saved by agent"
    });
    return `Waypoint saved: ${wp.name} @ ${Math.round(wp.x)},${Math.round(wp.y)},${Math.round(wp.z)}`;
  }
};

// ---- registry ---------------------------------------------------------------------------------

export const AGENT_TOOLS: AgentToolDef[] = [
  // info / perception (always available while system is on)
  listBots,
  getStatus,
  getInventory,
  lookAround,
  findBlocks,
  getRecentChat,
  getTasks,
  getBuildStatus,
  listWaypoints,
  listSchematicsTool,
  listTrusted,
  stopAll,
  // chat
  sendChatTool,
  sendWhisper,
  serverCommand, // gated: utility mode
  // movement
  gotoTool,
  gotoPlayer,
  followPlayer,
  gotoWaypoint,
  interactBlock,
  flyTo, // gated: utility mode + creative
  // gather
  collectWood,
  mineOre,
  collectBlocks,
  collectDrops,
  huntAnimals,
  // craft / survival
  craftItem,
  previewCraftPlan,
  cookFood,
  eatNow,
  sleepInBed,
  wakeUp,
  // inventory / storage
  depositItems,
  withdrawItems,
  giveItem,
  dropItems,
  equipItem,
  // build
  planStructure,
  buildStructure,
  buildSchematic,
  stopBuild,
  // combat
  attackPlayer,
  clearMobs,
  setSelfDefense,
  protectPlayer,
  fleeTool,
  stopCombat,
  // trust
  trustPlayerTool,
  untrustPlayerTool,
  // memory
  rememberTool,
  recallMemoriesTool,
  forgetMemoryTool,
  // waypoints
  saveWaypointHere
];

export function toolByName(name: string): AgentToolDef | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/** category toggle + (varsa) utility gate birlikte karar verir */
export function isToolEnabled(tool: AgentToolDef, settings: McpSettings): boolean {
  if (tool.category !== "info" && !settings.tools[tool.category]) return false;
  if (tool.gate && !tool.gate(settings)) return false;
  return true;
}

/** tools currently allowed by the permission toggles */
export function allowedTools(settings: McpSettings): AgentToolDef[] {
  return AGENT_TOOLS.filter((t) => isToolEnabled(t, settings));
}

/**
 * Execute a tool with uniform error handling. Returns { text, isError } —
 * errors are returned as text so LLMs can react to them instead of crashing the loop.
 */
export async function executeTool(
  ctx: AgentToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> {
  const tool = toolByName(name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  if (!isToolEnabled(tool, ctx.settings)) {
    const why = tool.gate ? "utility mode is off (own/permitted servers only — enable in the MCP tab)" : `category "${tool.category}" is disabled in the MCP panel`;
    return { text: `Tool "${name}" is unavailable: ${why}.`, isError: true };
  }
  try {
    const text = await tool.execute(ctx, args ?? {});
    return { text: text || "OK", isError: false };
  } catch (err) {
    return { text: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

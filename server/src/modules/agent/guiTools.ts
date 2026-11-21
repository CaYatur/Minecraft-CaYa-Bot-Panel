import type { AgentToolContext, AgentToolDef } from "./tools";
import { describeWindow, runGuiOp } from "../window";
import { BULK_ACTION_CATEGORY, BULK_ACTIONS, BULK_MAX_BOTS, bulkActionType, runBulkAction } from "../bulk";
import type { BotInstance } from "../../core/BotInstance";

/**
 * Issue #34 — sunucu menüleri (GUI), eldeki eşyayı kullanma ve seçili botlara
 * toplu işlem için MCP / Ollama araçları. Panelin REST ve socket yolu ile aynı
 * runGuiOp / runBulkAction fonksiyonlarını kullanır.
 */

const json = (value: unknown) => JSON.stringify(value);

function online(ctx: AgentToolContext) {
  if (!ctx.inst?.bot || ctx.inst.status !== "online") {
    throw new Error(`Bot "${ctx.inst?.config.username ?? "?"}" is not online (status: ${ctx.inst?.status ?? "?"}).`);
  }
}

const CLICK_BUTTONS = ["left", "right", "shift", "shift-right", "middle", "drop", "drop-stack", "number"];

export const GUI_TOOLS: AgentToolDef[] = [
  {
    name: "get_open_window",
    description:
      "Show the GUI window (container/menu) the bot has open right now: its title, type, window id and every menu slot with item name, custom display name and lore. " +
      "Server-selector / lobby menus (opened by right-clicking a compass, clock, nether star...) show up here. Slots 0..containerSlots-1 are the menu itself; " +
      "set includeInventory=true to also list the player's inventory part of the window. Returns 'No window is open' when nothing is open.",
    category: "info",
    inputSchema: {
      type: "object",
      properties: {
        includeInventory: { type: "boolean", description: "also list the player inventory rows of this window (default false)" },
        format: { type: "string", enum: ["text", "json"], description: "text summary (default) or the raw JSON snapshot" }
      }
    },
    async execute(ctx, args) {
      online(ctx);
      const snap = ctx.inst.windowSnapshot();
      if (args.format === "json") return json(snap);
      return describeWindow(snap, args.includeInventory === true);
    }
  },
  {
    name: "use_held_item",
    description:
      "Right-click (use / activate) the item in the bot's hand, like a player pressing right mouse button in the air. " +
      "Use this for lobby compasses / server selectors, clocks, menus, ender pearls, food (with holdMs), etc. " +
      "Optionally select a hotbar slot (0-8) or an item by name / custom name first. Waits up to waitWindowMs for a GUI window to open and returns it. " +
      "Typical server-selector flow: use_held_item {item:'compass'} → read the returned slots → click_window_slot {slot:N}.",
    category: "inventory",
    inputSchema: {
      type: "object",
      properties: {
        hotbar: { type: "number", description: "hotbar slot 0-8 to select first (optional)" },
        item: { type: "string", description: "item name (e.g. compass) or part of its custom name to hold first (optional)" },
        offhand: { type: "boolean", description: "use the off-hand item instead (default false)" },
        holdMs: { type: "number", description: "keep the button held this long (0-5000 ms; food, bows). Default 0 = single click" },
        waitWindowMs: { type: "number", description: "how long to wait for a window to open (0-10000 ms, default 2000)" }
      }
    },
    async execute(ctx, args) {
      online(ctx);
      const res = await runGuiOp(ctx.inst, { op: "use", ...args });
      if (res.op !== "use") return "Used.";
      const r = res.result;
      const head = `Used ${r.used ?? "empty hand"} (hotbar ${r.hotbar}).`;
      if (r.openedWindow) return `${head} A window opened:\n${describeWindow(r.window)}`;
      if (r.window.open) return `${head} A window is already open:\n${describeWindow(r.window)}`;
      return `${head} No window opened within the wait time (check get_recent_chat for a server reply).`;
    }
  },
  {
    name: "select_hotbar_slot",
    description: "Change the selected hotbar slot (0-8, left to right), i.e. what the bot holds in its main hand. Does not move the bot.",
    category: "inventory",
    inputSchema: {
      type: "object",
      properties: { slot: { type: "number", description: "hotbar slot 0-8" } },
      required: ["slot"]
    },
    async execute(ctx, args) {
      online(ctx);
      const res = await runGuiOp(ctx.inst, { op: "hotbar", hotbar: args.slot });
      return res.op === "hotbar" ? `Hotbar slot ${res.hotbar} selected (holding ${res.held ?? "nothing"}).` : "Hotbar set.";
    }
  },
  {
    name: "click_window_slot",
    description:
      "Click a slot of the currently open GUI window (server selector, shop, chest...). button: left (default, picks an option in most server menus), " +
      "right, shift (quick-move), shift-right, middle, drop, drop-stack, number (swap with hotbar slot given in `hotbar`). " +
      "Get slot numbers from get_open_window, or pass `item` (part of the item's name, custom name or lore, e.g. 'OneBlock') instead of `slot`. " +
      "Pass windowId to make sure the same menu is still open; waitWindowMs waits for a menu that is still opening. " +
      "Returns what changed: same (menu still open, maybe updated), new-window (another menu opened) or closed (e.g. the server sent you to the chosen game mode).",
    category: "inventory",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "number", description: "window slot number (0-based). Give slot or item" },
        item: { type: "string", description: "click the menu slot whose name, custom name or lore contains this text (used when slot is not given)" },
        waitWindowMs: { type: "number", description: "if no menu is open yet, wait this long for one (0-15000 ms, default 0)" },
        button: { type: "string", enum: CLICK_BUTTONS, description: "click type (default left)" },
        hotbar: { type: "number", description: "hotbar 0-8, only for button=number" },
        windowId: { type: "number", description: "expected window id from get_open_window (optional safety check)" },
        waitMs: { type: "number", description: "wait for the server's reaction (0-10000 ms, default 1200)" }
      }
    },
    async execute(ctx, args) {
      online(ctx);
      const res = await runGuiOp(ctx.inst, { op: "click", ...args });
      if (res.op !== "click") return "Clicked.";
      const r = res.result;
      const head = `Clicked slot ${r.clicked.slot} (${r.clicked.item ?? "empty"}) with ${r.clicked.button}. Result: ${r.changed}.`;
      return r.window.open ? `${head}\n${describeWindow(r.window)}` : `${head} No window is open now.`;
    }
  },
  {
    name: "close_window",
    description: "Close the GUI window the bot has open (like pressing Esc).",
    category: "inventory",
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      online(ctx);
      const res = await runGuiOp(ctx.inst, { op: "close" });
      return res.op === "close" && res.closed ? "Window closed." : "No window was open.";
    }
  },
  {
    name: "bulk_action",
    description:
      `Run ONE action on several bots at once (max ${BULK_MAX_BOTS}). Only bots with agent control enabled are accepted. ` +
      "Actions: start, stop, stop-work (cancel tasks), chat (text; {bot} becomes each bot's name; slash commands follow the same utility-mode rule as send_chat), " +
      "use-item (right-click; optional hotbar/item), hotbar (select slot), click-slot (slot, button), close-window. " +
      "Each action also needs its own permission category (chat → chat, GUI actions → inventory). Results are reported per bot; one failure does not stop the others.",
    category: "info",
    needsBot: false,
    inputSchema: {
      type: "object",
      properties: {
        bots: { type: "array", items: { type: "string" }, description: "bot usernames or ids; use [\"*\"] for every agent-enabled bot" },
        action: { type: "string", enum: BULK_ACTIONS.filter((a) => BULK_ACTION_CATEGORY[a] !== null), description: "action to run on every listed bot" },
        text: { type: "string", description: "chat text (chat action)" },
        hotbar: { type: "number", description: "hotbar slot 0-8 (hotbar / use-item)" },
        item: { type: "string", description: "item name to hold before use-item" },
        slot: { type: "number", description: "window slot (click-slot)" },
        button: { type: "string", enum: CLICK_BUTTONS, description: "click type (click-slot, default left)" },
        staggerMs: { type: "number", description: "delay between bots in ms (0-5000; default 200 for chat/use-item/click-slot)" }
      },
      required: ["bots", "action"]
    },
    async execute(ctx, args) {
      const type = bulkActionType(args.action);
      const category = BULK_ACTION_CATEGORY[type];
      if (category === null) throw new Error(`Action "${type}" is only available from the panel.`);
      if (category !== "info" && !ctx.settings.tools[category]) {
        throw new Error(`Action "${type}" needs the "${category}" tool category, which is disabled in the MCP panel.`);
      }
      if (type === "chat") {
        const text = String(args.text ?? "").trim();
        if (text.startsWith("/") && !/^\/(msg|tell|w|r|whisper)\b/i.test(text) && !(ctx.settings.utility.enabled && ctx.settings.utility.serverCommands)) {
          throw new Error("Slash commands are disabled. The owner can enable Utility mode → server commands in the MCP tab.");
        }
      }
      const all = [...ctx.manager.bots.values()];
      const enabled = (b: BotInstance) => Boolean(ctx.settings.bots[b.config.id]?.agentEnabled);
      const wanted = (Array.isArray(args.bots) ? args.bots : String(args.bots ?? "").split(/[\s,]+/)).map((v) => String(v).trim()).filter(Boolean);
      if (!wanted.length) throw new Error("Pass at least one bot in `bots` (see list_bots).");
      const ids: string[] = [];
      const refused: string[] = [];
      if (wanted.includes("*")) {
        for (const b of all) if (enabled(b)) ids.push(b.config.id);
      } else {
        for (const name of wanted) {
          const found =
            all.find((b) => b.config.username.toLowerCase() === name.toLowerCase()) ??
            all.find((b) => b.config.id === name || b.config.id.startsWith(name));
          if (!found) refused.push(`${name}: not found`);
          else if (!enabled(found)) refused.push(`${found.config.username}: agent control is disabled`);
          else ids.push(found.config.id);
        }
      }
      if (!ids.length) throw new Error(`No usable bots. ${refused.join("; ")}`.trim());
      const out = await runBulkAction(ctx.manager, ids, { ...args, type });
      const lines = [`bulk ${out.action}: ${out.okCount} ok, ${out.failCount} failed${refused.length ? `, ${refused.length} refused` : ""}`];
      for (const r of out.results) lines.push(`- ${r.username}: ${r.ok ? "ok" : "FAILED"} — ${r.message}`);
      for (const r of refused) lines.push(`- ${r} (skipped)`);
      return lines.join("\n");
    }
  },
  {
    name: "server_commands",
    description:
      "Read-only list of the slash commands this server told the bot it can use. The list comes from the command tree sent when the bot joins, and a new tree replaces it (for example after a server switch). Nothing is executed. " +
      "filter is an optional case-insensitive substring. Each line is one command; arguments look like <player>.",
    category: "info",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "optional substring matched against the command text, without the leading slash" },
        limit: { type: "number", description: "maximum lines to return (1-200, default 80)" }
      }
    },
    async execute(ctx, args) {
      online(ctx);
      const list = ctx.inst.serverCommandList();
      if (!list) return "The server has not sent a command list for this bot yet.";
      const filter = String(args.filter ?? "").trim().toLowerCase();
      const rawLimit = Number(args.limit ?? 80);
      const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 80));
      const matched = list.lines.filter((line) => !filter || line.toLowerCase().includes(filter));
      const shown = matched.slice(0, limit);
      if (!shown.length) return filter ? `No server commands match "${filter}".` : "The server command list is empty.";
      const title = filter ? `${matched.length} commands match "${filter}".` : `${matched.length} commands.`;
      const notes = [
        list.truncated ? "The stored list was cut short." : "",
        shown.length < matched.length ? `Showing ${shown.length}.` : ""
      ].filter(Boolean);
      const head = notes.length ? `${title} ${notes.join(" ")}` : title;
      return [head, ...shown.map((line) => `/${line}`)].join("\n");
    }
  }
];

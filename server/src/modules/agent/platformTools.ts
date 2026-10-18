import type { AgentToolContext, AgentToolDef } from "./tools";
import { loginSendMode } from "../alwaysOn/loginPrompt";
import { writeLoginSecret } from "../alwaysOn/secrets";
import { discordPublicState, notifyCustom, recentBridgeLines, updateDiscordSettings } from "../discord/hub";
import { validateTemplate, templateFromRules } from "../templates/schema";
import { deleteUserTemplate, getTemplate, listTemplates, saveUserTemplate } from "../templates/store";
import { ACTION_META } from "../automation/RuleEngine";
import { describeBot, renderSnapshot, startView, stopView, viewStatus } from "../view/session";

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return value == null ? fallback : String(value).trim();
}

function online(ctx: AgentToolContext) {
  if (!ctx.inst.bot || ctx.inst.status !== "online") throw new Error(`Bot "${ctx.inst.config.username}" is not online.`);
  return ctx.inst.bot;
}

const json = (value: unknown) => JSON.stringify(value);

export const PLATFORM_TOOLS: AgentToolDef[] = [
  {
    name: "always_on_get",
    description: "Read autostart, anti-AFK, and uptime. Passwords are not included.",
    category: "info",
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      return json(ctx.inst.alwaysOnStatus());
    }
  },
  {
    name: "always_on_set",
    description: "Turn anti-AFK on or off. A started bot already reconnects after a drop. Does not accept a password.",
    category: "info",
    inputSchema: {
      type: "object",
      properties: {
        antiAfk: { type: "boolean" },
        intervalMs: { type: "number" }
      }
    },
    async execute(ctx, args) {
      const current = ctx.inst.config.alwaysOn;
      if (!current) throw new Error("Always-on config is missing.");
      ctx.manager.updateBotConfig(ctx.inst.config.id, {
        alwaysOn: {
          ...current,
          antiAfk: {
            enabled: args.antiAfk === undefined ? current.antiAfk.enabled : Boolean(args.antiAfk),
            intervalMs: Number(args.intervalMs ?? current.antiAfk.intervalMs),
            mode: current.antiAfk.mode
          }
        }
      });
      return json(ctx.inst.alwaysOnStatus());
    }
  },
  {
    name: "login_plugin_set",
    description: "Save or clear the login-plugin password. The password is write-only and is never returned.",
    category: "info",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        password: { type: "string", description: "Write-only. Empty clears it." },
        delayMs: { type: "number" },
        maxFailures: { type: "number" },
        extraPattern: { type: "string" },
        loginRepeat: { type: "number", description: "1 sends /login password. 2 sends /login password password." },
        registerRepeat: { type: "number", description: "1 sends /register password. 2 sends /register password password." },
        loginTemplate: { type: "string", description: "Custom command. Use {password}. Empty uses loginRepeat." },
        registerTemplate: { type: "string", description: "Custom command. Use {password}. Empty uses registerRepeat." },
        sendMode: { type: "string", description: "prompt, login, or register_first. prompt waits for the server." }
      }
    },
    async execute(ctx, args) {
      if (args.password !== undefined) writeLoginSecret(ctx.inst.config.id, String(args.password ?? ""));
      const current = ctx.inst.config.alwaysOn;
      if (current) {
        ctx.manager.updateBotConfig(ctx.inst.config.id, {
          alwaysOn: {
            ...current,
            loginPlugin: {
              ...current.loginPlugin,
              enabled: args.enabled === undefined ? current.loginPlugin.enabled : Boolean(args.enabled),
              delayMs: Number(args.delayMs ?? current.loginPlugin.delayMs),
              maxFailures: Number(args.maxFailures ?? current.loginPlugin.maxFailures),
              extraPattern: args.extraPattern === undefined ? current.loginPlugin.extraPattern : String(args.extraPattern),
              loginRepeat: args.loginRepeat === undefined ? current.loginPlugin.loginRepeat : Number(args.loginRepeat) === 2 ? 2 : 1,
              registerRepeat: args.registerRepeat === undefined ? current.loginPlugin.registerRepeat : Number(args.registerRepeat) === 2 ? 2 : 1,
              loginTemplate: args.loginTemplate === undefined ? current.loginPlugin.loginTemplate : String(args.loginTemplate),
              registerTemplate: args.registerTemplate === undefined ? current.loginPlugin.registerTemplate : String(args.registerTemplate),
              sendMode: args.sendMode === undefined ? current.loginPlugin.sendMode : loginSendMode(args.sendMode)
            }
          }
        });
      }
      return json({ ok: true, hasPassword: ctx.inst.alwaysOnStatus().hasPassword });
    }
  },
  {
    name: "uptime_stats",
    description: "Current and total uptime, sessions, and the last disconnect reasons.",
    category: "info",
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      return json(ctx.inst.alwaysOnStatus().uptime);
    }
  },
  {
    name: "reconnect_status",
    description: "Reconnect state, attempt, and next retry time.",
    category: "info",
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      return json(ctx.inst.alwaysOnStatus().reconnect);
    }
  },
  {
    name: "reconnect_cancel",
    description: "Stop the current reconnect loop without deleting the bot.",
    category: "info",
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      ctx.manager.stopBot(ctx.inst.config.id);
      return "Reconnect cancelled.";
    }
  },
  {
    name: "discord_status",
    description: "Discord webhook and gateway state. Tokens and webhook URLs are masked.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return json(discordPublicState());
    }
  },
  {
    name: "discord_notify",
    description: "Send a custom message through the saved Discord webhook.",
    category: "info",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    async execute(ctx, args) {
      notifyCustom(ctx.inst.config.username, str(args, "message"));
      return "Notification queued.";
    }
  },
  {
    name: "discord_events_set",
    description: "Toggle Discord notification events.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: { events: { type: "object" } } },
    async execute(_ctx, args) {
      const events = args.events && typeof args.events === "object" ? (args.events as Record<string, boolean>) : {};
      return json(updateDiscordSettings({ events: events as never }));
    }
  },
  {
    name: "discord_bridge_get",
    description: "Read the Minecraft-Discord chat bridge settings.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const state = discordPublicState();
      return json(state.bridge);
    }
  },
  {
    name: "discord_bridge_set",
    description: "Enable or disable the chat bridge and set its channel and rate limit.",
    category: "info",
    needsBot: false,
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        channelId: { type: "string" },
        maxPerMinute: { type: "number" }
      }
    },
    async execute(_ctx, args) {
      const current = discordPublicState().bridge;
      return json(updateDiscordSettings({
        bridge: {
          enabled: args.enabled === undefined ? current.enabled : Boolean(args.enabled),
          channelId: args.channelId === undefined ? current.channelId : String(args.channelId),
          maxPerMinute: Number(args.maxPerMinute ?? current.maxPerMinute)
        }
      }));
    }
  },
  {
    name: "discord_allowlist_get",
    description: "Read the Discord command allowlist. An empty allowlist denies every command.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return json(discordPublicState().allow);
    }
  },
  {
    name: "discord_allowlist_set",
    description: "Replace the Discord user and role allowlist.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: { userIds: { type: "array" }, roleIds: { type: "array" } } },
    async execute(_ctx, args) {
      const userIds = Array.isArray(args.userIds) ? args.userIds.map(String) : [];
      const roleIds = Array.isArray(args.roleIds) ? args.roleIds.map(String) : [];
      return json(updateDiscordSettings({ allow: { userIds, roleIds } }));
    }
  },
  {
    name: "discord_recent_messages",
    description: "Last Minecraft lines waiting to be bridged to Discord.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return json({ lines: recentBridgeLines() });
    }
  },
  {
    name: "template_list",
    description: "List bundled and saved automation templates.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return json({ templates: listTemplates() });
    }
  },
  {
    name: "template_get",
    description: "Read one automation template by name or id.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async execute(_ctx, args) {
      const found = getTemplate(str(args, "name"));
      if (!found) throw new Error("Template not found.");
      return json(found);
    }
  },
  {
    name: "template_export",
    description: "Export the current automation rules as a versioned template. Secrets are removed.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      return json(templateFromRules("Exported rules", "Rules exported from the panel", ctx.manager.rules.list()));
    }
  },
  {
    name: "template_import",
    description: "Validate an automation template. Set apply true to create the rules after validation.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: { template: { type: "object" }, apply: { type: "boolean" } }, required: ["template"] },
    async execute(ctx, args) {
      const allowed = new Set(ACTION_META.map((row) => row.type));
      const checked = validateTemplate(args.template, allowed);
      if (!checked.ok || !checked.template) throw new Error(checked.errors.join(" "));
      const created = args.apply === true ? checked.template.rules.map((rule) => ctx.manager.rules.create(rule as never)) : [];
      return json({ ok: true, warnings: checked.warnings, created: created.map((rule) => rule.id) });
    }
  },
  {
    name: "template_delete",
    description: "Delete a user-saved template. Bundled templates cannot be deleted.",
    category: "info",
    needsBot: false,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async execute(_ctx, args) {
      if (!deleteUserTemplate(str(args, "id"))) throw new Error("Template not found.");
      return "Deleted.";
    }
  },
  {
    name: "bot_view_describe",
    description: "Describe what is inside the bot view cone. Does not move the head unless applyLook is true.",
    category: "info",
    inputSchema: {
      type: "object",
      properties: {
        yaw: { type: "number" },
        pitch: { type: "number" },
        fov: { type: "number" },
        radius: { type: "number" },
        applyLook: { type: "boolean" }
      }
    },
    async execute(ctx, args) {
      const bot = online(ctx);
      return json(describeBot(bot, {
        yaw: args.yaw === undefined ? undefined : Number(args.yaw),
        pitch: args.pitch === undefined ? undefined : Number(args.pitch),
        fov: args.fov === undefined ? undefined : Number(args.fov),
        radius: args.radius === undefined ? undefined : Number(args.radius),
        applyLook: args.applyLook === true
      }));
    }
  },
  {
    name: "bot_view_screenshot",
    description: "Render a first-person PNG of what this bot sees. This is how an MCP session sees the world. Caps at 1280x720. Does not move the bot. The live 3D page is only for the panel.",
    category: "info",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
        viewDistance: { type: "number" },
        yaw: { type: "number" },
        pitch: { type: "number" }
      }
    },
    async execute(ctx, args) {
      const bot = online(ctx);
      const width = Number(args.width ?? 640);
      const height = Number(args.height ?? 360);
      const shot = await renderSnapshot(bot, {
        width,
        height,
        viewDistance: args.viewDistance === undefined ? undefined : Number(args.viewDistance),
        yaw: args.yaw === undefined ? undefined : Number(args.yaw),
        pitch: args.pitch === undefined ? undefined : Number(args.pitch)
      });
      if (!shot.ok) throw new Error(`${shot.code}: ${shot.message}`);
      return { text: `POV frame ${shot.width}x${shot.height}`, image: { data: shot.base64, mimeType: shot.mimeType } };
    }
  },
  {
    name: "bot_view_start",
    description: "Start the local 3D page for the panel. An MCP client cannot open that page. Use bot_view_screenshot to see the view.",
    category: "info",
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      const bot = online(ctx);
      const version = ctx.manager.getServer(ctx.inst.config.serverId)?.version ?? bot.version;
      const started = await startView(ctx.inst.config.id, bot, version);
      if (!started.ok) throw new Error(`${started.code}: ${started.message}`);
      return json(started);
    }
  },
  {
    name: "bot_view_stop",
    description: "Stop the 3D viewer for this bot.",
    category: "info",
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      await stopView(ctx.inst.config.id);
      return "Viewer stopped.";
    }
  },
  {
    name: "bot_view_status",
    description: "Whether the panel 3D page is running. MCP vision uses bot_view_screenshot, not this page.",
    category: "info",
    inputSchema: { type: "object", properties: {} },
    async execute(ctx) {
      return json(viewStatus(ctx.inst.config.id));
    }
  }
];

import { createLogger } from "../../utils/logger";
import {
  allowSend,
  batchLines,
  escapeDiscordMentions,
  formatDiscordLine,
  formatMinecraftLine,
  isAllowlisted,
  sayIsBlocked,
  shouldBridgeDiscord,
  shouldBridgeMinecraft
} from "./logic";
import { publicDiscordSettings, readDiscordSecrets, readDiscordSettings, writeDiscordSecrets, writeDiscordSettings, type DiscordEvents, type DiscordSettings } from "./store";

const log = createLogger("discord");

export interface DiscordBotControl {
  list(): Array<{ id: string; username: string; status: string }>;
  start(username: string): string;
  stop(username: string): string;
  say(username: string, text: string): string;
  status(username: string): string;
}

let control: DiscordBotControl | null = null;
let client: { destroy(): Promise<void> } | null = null;
let gateway: "off" | "connecting" | "ready" | "error" | "unavailable" = "off";
let gatewayError: string | null = null;
const sendTimes: number[] = [];
const pendingLines: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
const lowHealthLatch = new Set<string>();

export function setDiscordControl(next: DiscordBotControl): void {
  control = next;
}

export function discordPublicState() {
  return { ...publicDiscordSettings(), gateway, gatewayError };
}

export function updateDiscordSettings(patch: Partial<DiscordSettings> & { token?: string | null; webhookUrl?: string | null }): ReturnType<typeof discordPublicState> {
  const { token, webhookUrl, ...rest } = patch;
  if (Object.keys(rest).length) writeDiscordSettings(rest);
  if (token !== undefined || webhookUrl !== undefined) writeDiscordSecrets({ token, webhookUrl });
  if (token !== undefined) void connectDiscord().catch((err) => log.warn("Discord reconnect failed", String(err)));
  return discordPublicState();
}

export async function postWebhook(url: string, content: string): Promise<{ ok: boolean; error?: string }> {
  const body = escapeDiscordMentions(content).slice(0, 1900);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: body, allowed_mentions: { parse: [] } })
    });
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, Math.min(5_000, Math.ceil((data.retry_after ?? 1) * 1000))));
      const retry = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: body, allowed_mentions: { parse: [] } })
      });
      if (!retry.ok) return { ok: false, error: `Discord answered ${retry.status}` };
      return { ok: true };
    }
    if (!res.ok) return { ok: false, error: `Discord answered ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function notifyCustom(botName: string, text: string): void {
  const url = readDiscordSecrets().webhookUrl;
  if (!url || !text.trim()) return;
  void postWebhook(url, `[${botName}] ${text}`).then((result) => {
    if (!result.ok) log.warn("Discord notification dropped", result.error);
  });
}

export async function testWebhook(url?: string): Promise<{ ok: boolean; error?: string }> {
  const target = url?.trim() || readDiscordSecrets().webhookUrl;
  if (!target) return { ok: false, error: "No webhook URL is saved." };
  const result = await postWebhook(target, "CaYa Bot Panel webhook test");
  if (!result.ok) log.warn("Webhook test failed", result.error);
  else log.info("Webhook test sent");
  return result;
}

export function notifyDiscord(botName: string, event: keyof DiscordEvents, text: string): void {
  const settings = readDiscordSettings();
  if (!settings.events[event]) return;
  const secrets = readDiscordSecrets();
  if (!secrets.webhookUrl) return;
  const line = escapeDiscordMentions(`[${botName}] ${text}`).slice(0, 1800);
  void postWebhook(secrets.webhookUrl, line).then((result) => {
    if (!result.ok) log.warn("Discord notification dropped", result.error);
  });
}

export function noteHealth(botId: string, botName: string, health: number): void {
  if (health >= 8) lowHealthLatch.delete(botId);
  if (health > 0 && health < 6 && !lowHealthLatch.has(botId)) {
    lowHealthLatch.add(botId);
    notifyDiscord(botName, "lowHealth", `Health is ${health}`);
  }
}

export function bridgeFromMinecraft(input: { botId: string; botName: string; username?: string; text: string; self?: boolean; kind: string }): void {
  const settings = readDiscordSettings();
  if (!settings.bridge.enabled || !settings.bridge.channelId) return;
  if (input.kind === "whisper") {
    notifyDiscord(input.botName, "whisper", `${input.username ?? "someone"} whispers: ${input.text}`);
  }
  if (input.username && input.text.toLowerCase().includes(input.botName.toLowerCase())) {
    notifyDiscord(input.botName, "mention", `${input.username}: ${input.text}`);
  }
  if (!shouldBridgeMinecraft({ self: Boolean(input.self), username: input.username ?? "", botName: input.botName, text: input.text })) return;
  const now = Date.now();
  if (!allowSend(sendTimes, now, settings.bridge.maxPerMinute)) return;
  pendingLines.push(formatMinecraftLine(input.username || "server", input.text));
  if (pendingLines.length > 40) pendingLines.splice(0, pendingLines.length - 40);
  if (!flushTimer) flushTimer = setTimeout(() => void flushBridge(), 2_000);
}

async function flushBridge(): Promise<void> {
  flushTimer = null;
  const lines = pendingLines.splice(0, pendingLines.length);
  if (!lines.length || !client) return;
  const settings = readDiscordSettings();
  const channelId = settings.bridge.channelId;
  if (!channelId) return;
  try {
    const channel = await (client as unknown as { channels: { fetch(id: string): Promise<{ isTextBased(): boolean; send(body: unknown): Promise<unknown> } | null> } }).channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    for (const chunk of batchLines(lines)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    log.warn("Chat bridge flush failed", err instanceof Error ? err.message : String(err));
  }
}

export async function connectDiscord(): Promise<void> {
  await disconnectDiscord();
  const token = readDiscordSecrets().token;
  if (!token) {
    gateway = "off";
    gatewayError = null;
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let discord: any;
  try {
    discord = require("discord.js");
  } catch {
    gateway = "unavailable";
    gatewayError = "discord.js is not installed. Webhooks still work.";
    return;
  }
  gateway = "connecting";
  gatewayError = null;
  const bot = new discord.Client({
    intents: [
      discord.GatewayIntentBits.Guilds,
      discord.GatewayIntentBits.GuildMessages,
      discord.GatewayIntentBits.MessageContent
    ]
  });
  client = bot;
  bot.once("ready", async () => {
    gateway = "ready";
    gatewayError = null;
    log.info("Discord gateway ready");
    try {
      const settings = readDiscordSettings();
      const body = [
        new discord.SlashCommandBuilder()
          .setName("bot")
          .setDescription("Control a CaYa panel bot")
          .addSubcommand((sub: any) => sub.setName("start").setDescription("Start a bot").addStringOption((opt: any) => opt.setName("name").setDescription("Bot username").setRequired(true).setAutocomplete(true)))
          .addSubcommand((sub: any) => sub.setName("stop").setDescription("Stop a bot").addStringOption((opt: any) => opt.setName("name").setDescription("Bot username").setRequired(true).setAutocomplete(true)))
          .addSubcommand((sub: any) =>
            sub
              .setName("say")
              .setDescription("Send chat as the bot")
              .addStringOption((opt: any) => opt.setName("name").setDescription("Bot username").setRequired(true).setAutocomplete(true))
              .addStringOption((opt: any) => opt.setName("text").setDescription("Chat text").setRequired(true))
          )
          .addSubcommand((sub: any) => sub.setName("status").setDescription("Show bot status").addStringOption((opt: any) => opt.setName("name").setDescription("Bot username").setRequired(true).setAutocomplete(true)))
      ].map((cmd: any) => cmd.toJSON());
      const rest = new discord.REST({ version: "10" }).setToken(token);
      if (settings.guildId) await rest.put(discord.Routes.applicationGuildCommands(bot.user.id, settings.guildId), { body });
    } catch (err) {
      gatewayError = err instanceof Error ? err.message : String(err);
      log.warn("Could not register slash commands", gatewayError);
    }
  });
  bot.on("error", (err: Error) => {
    gateway = "error";
    gatewayError = err.message;
    log.warn("Discord gateway error", err.message);
  });
  bot.on("messageCreate", async (message: { author: { bot?: boolean; username: string }; content: string; channelId: string; guildId?: string }) => {
    const settings = readDiscordSettings();
    if (!settings.bridge.enabled || message.channelId !== settings.bridge.channelId) return;
    if (settings.guildId && message.guildId && message.guildId !== settings.guildId) return;
    if (!shouldBridgeDiscord({ authorIsBot: Boolean(message.author.bot), text: message.content })) return;
    const target = control?.list()[0];
    if (!target) return;
    try {
      control?.say(target.username, formatDiscordLine(message.author.username, message.content));
    } catch (err) {
      log.warn("Bridge to Minecraft failed", err instanceof Error ? err.message : String(err));
    }
  });
  bot.on("interactionCreate", async (interaction: any) => {
    try {
      await onInteraction(interaction);
    } catch (err) {
      log.warn("Discord command failed", err instanceof Error ? err.message : String(err));
    }
  });
  try {
    await bot.login(token);
  } catch (err) {
    gateway = "error";
    gatewayError = err instanceof Error ? err.message : String(err);
    log.warn("Discord login failed", gatewayError);
    client = null;
  }
}

async function onInteraction(interaction: any): Promise<void> {
  const settings = readDiscordSettings();
  if (interaction.isAutocomplete()) {
    const focused = String(interaction.options.getFocused() ?? "").toLowerCase();
    const choices = (control?.list() ?? [])
      .map((bot) => bot.username)
      .filter((name) => name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((name) => ({ name, value: name }));
    await interaction.respond(choices);
    return;
  }
  if (!interaction.isChatInputCommand() || interaction.commandName !== "bot") return;
  if (settings.guildId && interaction.guildId !== settings.guildId) {
    await interaction.reply({ content: "This server is not allowed.", ephemeral: true });
    return;
  }
  const roles = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [];
  if (!isAllowlisted(interaction.user.id, roles, settings.allow)) {
    log.info(`Discord command denied for ${interaction.user.id}`);
    await interaction.reply({ content: "Not allowed.", ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  const name = String(interaction.options.getString("name") ?? "");
  log.info(`Discord ${sub} by ${interaction.user.id} for ${name}`);
  if (!control) {
    await interaction.reply({ content: "Panel is not ready.", ephemeral: true });
    return;
  }
  try {
    if (sub === "say") {
      const text = String(interaction.options.getString("text") ?? "");
      if (sayIsBlocked(text, settings.sayAllowsCommands)) {
        await interaction.reply({ content: "Server commands are not allowed from Discord.", ephemeral: true });
        return;
      }
      await interaction.reply({ content: control.say(name, text), ephemeral: true });
      return;
    }
    const reply = sub === "start" ? control.start(name) : sub === "stop" ? control.stop(name) : control.status(name);
    await interaction.reply({ content: reply, ephemeral: true });
  } catch (err) {
    await interaction.reply({ content: err instanceof Error ? err.message : String(err), ephemeral: true });
  }
}

export async function disconnectDiscord(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const current = client;
  client = null;
  gateway = "off";
  if (current) await current.destroy().catch(() => undefined);
}

export function recentBridgeLines(): string[] {
  return pendingLines.slice(-20);
}

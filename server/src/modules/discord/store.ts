import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../../config/paths";
import { loadJson, saveJson } from "../../persistence/store";
import { maskWebhook, type DiscordAllow } from "./logic";

export interface DiscordEvents {
  death: boolean;
  disconnect: boolean;
  reconnect: boolean;
  mention: boolean;
  whisper: boolean;
  taskDone: boolean;
  taskFailed: boolean;
  lowHealth: boolean;
}

export interface DiscordSettings {
  guildId: string;
  statusChannelId: string;
  bridge: { enabled: boolean; channelId: string; maxPerMinute: number };
  allow: DiscordAllow;
  sayAllowsCommands: boolean;
  events: DiscordEvents;
}

const PUBLIC_FILE = "discord.json";
const SECRET_FILE = "discord-secrets.json";

export function defaultDiscordSettings(): DiscordSettings {
  return {
    guildId: "",
    statusChannelId: "",
    bridge: { enabled: false, channelId: "", maxPerMinute: 20 },
    allow: { userIds: [], roleIds: [] },
    sayAllowsCommands: false,
    events: {
      death: false,
      disconnect: false,
      reconnect: false,
      mention: false,
      whisper: false,
      taskDone: false,
      taskFailed: false,
      lowHealth: false
    }
  };
}

export function readDiscordSettings(): DiscordSettings {
  const loaded = loadJson<Partial<DiscordSettings>>(PUBLIC_FILE, {});
  const base = defaultDiscordSettings();
  return {
    ...base,
    ...loaded,
    bridge: { ...base.bridge, ...(loaded.bridge ?? {}) },
    allow: {
      userIds: Array.isArray(loaded.allow?.userIds) ? loaded.allow.userIds.map(String) : [],
      roleIds: Array.isArray(loaded.allow?.roleIds) ? loaded.allow.roleIds.map(String) : []
    },
    events: { ...base.events, ...(loaded.events ?? {}) }
  };
}

export function writeDiscordSettings(patch: Partial<DiscordSettings>): DiscordSettings {
  const next = readDiscordSettings();
  const merged: DiscordSettings = {
    ...next,
    ...patch,
    bridge: { ...next.bridge, ...(patch.bridge ?? {}) },
    allow: patch.allow
      ? {
          userIds: patch.allow.userIds.map(String).slice(0, 50),
          roleIds: patch.allow.roleIds.map(String).slice(0, 50)
        }
      : next.allow,
    events: { ...next.events, ...(patch.events ?? {}) },
    sayAllowsCommands: patch.sayAllowsCommands ?? next.sayAllowsCommands
  };
  merged.bridge.maxPerMinute = Math.min(50, Math.max(1, Math.round(merged.bridge.maxPerMinute || 20)));
  void saveJson(PUBLIC_FILE, merged);
  return merged;
}

function secretPath(): string {
  return path.join(DATA_DIR, SECRET_FILE);
}

function readSecrets(): { token?: string; webhookUrl?: string } {
  try {
    if (!fs.existsSync(secretPath())) return {};
    return JSON.parse(fs.readFileSync(secretPath(), "utf8")) as { token?: string; webhookUrl?: string };
  } catch {
    return {};
  }
}

function writeSecrets(data: { token?: string; webhookUrl?: string }): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = secretPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, secretPath());
}

export function readDiscordSecrets(): { token: string | null; webhookUrl: string | null } {
  const raw = readSecrets();
  return { token: raw.token ? String(raw.token) : null, webhookUrl: raw.webhookUrl ? String(raw.webhookUrl) : null };
}

export function writeDiscordSecrets(patch: { token?: string | null; webhookUrl?: string | null }): void {
  const current = readSecrets();
  if (patch.token !== undefined) {
    if (patch.token) current.token = patch.token.trim();
    else delete current.token;
  }
  if (patch.webhookUrl !== undefined) {
    if (patch.webhookUrl) current.webhookUrl = patch.webhookUrl.trim();
    else delete current.webhookUrl;
  }
  writeSecrets(current);
}

export function publicDiscordSettings(): DiscordSettings & { hasToken: boolean; hasWebhook: boolean; webhookMasked: string | null } {
  const settings = readDiscordSettings();
  const secrets = readDiscordSecrets();
  return { ...settings, hasToken: Boolean(secrets.token), hasWebhook: Boolean(secrets.webhookUrl), webhookMasked: maskWebhook(secrets.webhookUrl) };
}

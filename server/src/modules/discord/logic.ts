export interface DiscordAllow {
  userIds: string[];
  roleIds: string[];
}

const MENTION = /@everyone|@here|<@&\d+>/g;

export function escapeDiscordMentions(text: string): string {
  return text.replace(MENTION, (hit) => hit.replace("@", "@\u200b"));
}

export function maskWebhook(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/\/webhooks\/\d+\/[^/?#]+/i, "/webhooks/••••/••••");
}

export function isAllowlisted(userId: string, roleIds: string[], allow: DiscordAllow): boolean {
  if (allow.userIds.includes(userId)) return true;
  return roleIds.some((id) => allow.roleIds.includes(id));
}

export function sayIsBlocked(text: string, sayAllowsCommands: boolean): boolean {
  const clean = text.trim();
  return clean.startsWith("/") && !sayAllowsCommands;
}

/** Messages the bridge itself wrote must not be sent back. */
export function shouldBridgeMinecraft(input: { self: boolean; username: string; botName: string; text: string }): boolean {
  if (input.self) return false;
  if (input.username && input.username.toLowerCase() === input.botName.toLowerCase()) return false;
  if (/^\[Discord\]/.test(input.text.trim())) return false;
  if (/\/(?:login|register|reg|l)\b/i.test(input.text)) return false;
  return input.text.trim().length > 0;
}

export function shouldBridgeDiscord(input: { authorIsBot: boolean; text: string }): boolean {
  if (input.authorIsBot) return false;
  if (/^\[MC\]/.test(input.text.trim())) return false;
  return input.text.trim().length > 0;
}

export function formatMinecraftLine(username: string, text: string): string {
  const body = escapeDiscordMentions(text).slice(0, 1500);
  return `[MC] ${username}: ${body}`.slice(0, 1800);
}

export function formatDiscordLine(author: string, text: string): string {
  return `[Discord] ${author}: ${text.replace(/[\r\n]+/g, " ").slice(0, 200)}`;
}

export function batchLines(lines: string[], maxChars = 1800): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChars) {
      if (current) out.push(current);
      current = line.slice(0, maxChars);
    } else {
      current = next;
    }
  }
  if (current) out.push(current);
  return out;
}

export function allowSend(history: number[], now: number, maxPerMinute: number): boolean {
  const recent = history.filter((ts) => now - ts < 60_000);
  history.length = 0;
  history.push(...recent);
  if (recent.length >= maxPerMinute) return false;
  history.push(now);
  return true;
}

/** Same rule as the server: only real Discord webhook endpoints. */
export function looksLikeDiscordWebhook(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(url.hostname.toLowerCase()) &&
      /^\/api\/(v\d+\/)?webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** A custom login/register command must contain the {password} placeholder. */
export function templateValid(value: string): boolean {
  return !value || value.includes("{password}");
}


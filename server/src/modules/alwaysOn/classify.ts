export type DisconnectKind = "ban" | "whitelist" | "duplicate" | "restart" | "timeout" | "closed" | "auth" | "other";

/** Ban, whitelist, and duplicate-login kicks stop the reconnect loop. Restarts and timeouts retry. */
export function classifyDisconnect(text: string): { kind: DisconnectKind; retry: boolean } {
  const lower = text.toLowerCase();
  if (/premium verification|unverified_username|invalid session|failed to verify username|name_taken|already connected|already online/.test(lower)) {
    return { kind: "auth", retry: false };
  }
  if (/\bbanned\b|you are banned|ban id|permanently banned/.test(lower)) return { kind: "ban", retry: false };
  if (/whitelist|not white-?listed|white-?list/.test(lower)) return { kind: "whitelist", retry: false };
  if (/duplicate login|logged in from another|another location/.test(lower)) return { kind: "duplicate", retry: false };
  if (/restart|server closed|server is restarting|shutting down|closed the connection/.test(lower)) {
    return { kind: "restart", retry: true };
  }
  if (/timed out|timeout|econnrefused|connection refused|endofstream|socket hang up/.test(lower)) {
    return { kind: "timeout", retry: true };
  }
  if (/server is offline|server is starting|in queue|starting up/.test(lower)) return { kind: "closed", retry: true };
  return { kind: "other", retry: true };
}

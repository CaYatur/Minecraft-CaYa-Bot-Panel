/**
 * Helpers for turning Minecraft chat components / network errors into
 * human-readable English strings for the panel log (I1: errors go to panel, never game chat).
 */

const TRANSLATE_MAP: Record<string, string> = {
  "multiplayer.disconnect.unverified_username":
    "Server requires premium verification (online-mode=true) — an offline bot can't join this server.",
  "multiplayer.disconnect.duplicate_login": "Another login with the same username occurred (in offline mode, name = identity).",
  "multiplayer.disconnect.server_full": "Server is full.",
  "multiplayer.disconnect.banned": "Bot is banned from this server.",
  "multiplayer.disconnect.kicked": "Kicked by a staff member.",
  "multiplayer.disconnect.idling": "Kicked for being idle too long (AFK kick).",
  "multiplayer.disconnect.outdated_client": "Version mismatch: client version is older than the server — pick the right version in the panel.",
  "multiplayer.disconnect.incompatible": "Version mismatch — pick the right version in the panel.",
  "multiplayer.disconnect.outdated_server": "Version mismatch: server is on an older version — pick the right version in the panel.",
  "disconnect.spam": "Kicked for spam (raise the chat rate limit)."
};

/** recursively extract plain text from a chat component (string | object | json string) */
export function chatComponentToText(reason: unknown): string {
  if (reason == null) return "";
  if (typeof reason === "string") {
    const trimmed = reason.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
      try {
        return chatComponentToText(JSON.parse(trimmed));
      } catch {
        return reason;
      }
    }
    return reason;
  }
  if (Array.isArray(reason)) return reason.map(chatComponentToText).join("");
  if (typeof reason === "object") {
    const obj = reason as Record<string, unknown>;
    // prismarine ChatMessage instance
    if (typeof (obj as any).toString === "function" && (obj as any).json !== undefined) {
      try {
        const s = String(reason);
        if (s && s !== "[object Object]") return s;
      } catch {
        /* fall through */
      }
    }
    let out = "";
    if (typeof obj.translate === "string") {
      const mapped = TRANSLATE_MAP[obj.translate];
      const params = Array.isArray(obj.with) ? obj.with.map(chatComponentToText).filter(Boolean).join(", ") : "";
      out += mapped ?? obj.translate + (params ? ` (${params})` : "");
      if (mapped && params) out += ` (${params})`;
    }
    if (typeof obj.text === "string") out += obj.text;
    if (Array.isArray(obj.extra)) out += obj.extra.map(chatComponentToText).join("");
    return out;
  }
  return String(reason);
}

/** map low-level connection errors to actionable English messages */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ECONNREFUSED")) return "Could not reach the server (connection refused) — is the IP/port correct and the server online?";
  if (msg.includes("ENOTFOUND")) return "Could not resolve server address — check the IP/domain.";
  if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) return "Connection timed out — is the server reachable?";
  if (msg.includes("EHOSTUNREACH")) return "No network route to the server (host unreachable).";
  if (msg.includes("ECONNRESET")) return "Connection was reset by the server (connection reset).";
  if (msg.toLowerCase().includes("unsupported") && msg.toLowerCase().includes("version"))
    return `Unsupported/undetected version — try picking the version manually in the panel. (${msg})`;
  if (msg.includes("RateLimiter") || msg.includes("rate limit")) return "Server rate-limited the connection — will retry shortly.";
  return msg;
}

/** strip legacy §x color codes (for plain-text handling) */
export function stripLegacyCodes(s: string): string {
  return s.replace(/§[0-9a-fk-orx]/gi, "");
}

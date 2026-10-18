import { redactSecrets } from "../../utils/redact";

/** Stable UI keys. English text is the log line; the panel translates the key. */
export const AUTH_ERRORS = {
  "auth.timeout": "Microsoft did not return a device code. Check the network and try again.",
  "auth.expired": "The Microsoft device code expired. Start sign-in again.",
  "auth.cancelled": "Microsoft sign-in was cancelled.",
  "auth.noLicense": "This Microsoft account does not have a Minecraft Java license (or the Xbox profile is missing).",
  "auth.child": "Microsoft blocked this account (child account or age restriction).",
  "auth.rateLimit": "Microsoft rate-limited the sign-in. Wait a few minutes and try again.",
  "auth.network": "Network error while contacting Microsoft. The bot was not left in a login loop.",
  "auth.reauth": "Microsoft session expired. Sign in again from Accounts. Auto-reconnect will not open a new device code.",
  "auth.mismatchOffline": "This server requires a Microsoft account. Switch the bot to Microsoft auth and sign in.",
  "auth.mismatchPremium": "Premium verification failed for this Microsoft account. Sign in again from Accounts.",
  "auth.sessionRejected": "The server rejected the Microsoft session. Sign in again from Accounts.",
  "auth.failed": "Microsoft sign-in failed."
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERRORS;

export function authEnglish(code: AuthErrorCode, detail?: string): string {
  const base = AUTH_ERRORS[code];
  if (!detail || code === "auth.failed") {
    return code === "auth.failed" && detail ? `${base} ${redactSecrets(detail)}` : base;
  }
  return base;
}

export function classifyAuthError(err: unknown): AuthErrorCode {
  const msg = redactSecrets(err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/expir/.test(msg)) return "auth.expired";
  if (/cancel/.test(msg)) return "auth.cancelled";
  if (/child|underage|under age|adult/.test(msg)) return "auth.child";
  if (/own minecraft|does not own|no minecraft|not found|xbox profile|entitlement/.test(msg)) return "auth.noLicense";
  if (/429|too many|rate limit/.test(msg)) return "auth.rateLimit";
  if (/enotfound|econnreset|etimedout|econnrefused|network|getaddrinfo|fetch failed/.test(msg)) return "auth.network";
  return "auth.failed";
}

export function classifyKick(
  text: string,
  auth: "offline" | "microsoft"
): { code?: AuthErrorCode; stop: boolean; message: string } {
  const lower = text.toLowerCase();
  const premium =
    lower.includes("premium verification") ||
    lower.includes("unverified_username") ||
    lower.includes("this server requires");
  if (premium) {
    const code = auth === "microsoft" ? "auth.mismatchPremium" : "auth.mismatchOffline";
    return { code, stop: true, message: AUTH_ERRORS[code] };
  }
  const session = lower.includes("invalid session") || lower.includes("failed to verify username");
  if (session) {
    const code = auth === "microsoft" ? "auth.sessionRejected" : "auth.mismatchOffline";
    return { code, stop: true, message: AUTH_ERRORS[code] };
  }
  return { stop: false, message: text };
}

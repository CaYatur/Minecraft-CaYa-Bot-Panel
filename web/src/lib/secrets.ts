/** Replaces every copy of `secret` in `text` with dots plus its last 4 characters. */
export function maskSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join(`${"•".repeat(12)}${secret.slice(-4)}`);
}

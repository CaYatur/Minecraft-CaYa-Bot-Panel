/** Strip tokens and device-code secrets before anything is logged or sent to the panel. */
export function redactSecrets(input: string): string {
  return input
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /(access[_-]?token|refresh[_-]?token|device_code|client_secret|xsts[_-]?token)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1$2[redacted]"
    );
}

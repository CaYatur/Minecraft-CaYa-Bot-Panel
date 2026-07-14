/**
 * Helpers for turning Minecraft chat components / network errors into
 * human-readable Turkish strings for the panel log (İ1: errors go to panel, never game chat).
 */

const TRANSLATE_MAP: Record<string, string> = {
  "multiplayer.disconnect.unverified_username":
    "Sunucu premium doğrulama istiyor (online-mode=true) — offline bot bu sunucuya giremez.",
  "multiplayer.disconnect.duplicate_login": "Aynı kullanıcı adıyla başka bir giriş yapıldı (offline modda isim = kimlik).",
  "multiplayer.disconnect.server_full": "Sunucu dolu.",
  "multiplayer.disconnect.banned": "Bot bu sunucudan yasaklı.",
  "multiplayer.disconnect.kicked": "Bir yetkili tarafından atıldı.",
  "multiplayer.disconnect.idling": "Uzun süre hareketsiz kalındığı için atıldı (AFK kick).",
  "multiplayer.disconnect.outdated_client": "Sürüm uyumsuz: istemci sürümü sunucudan eski — panelden doğru sürümü seç.",
  "multiplayer.disconnect.incompatible": "Sürüm uyumsuz — panelden doğru sürümü seç.",
  "multiplayer.disconnect.outdated_server": "Sürüm uyumsuz: sunucu daha eski bir sürümde — panelden doğru sürümü seç.",
  "disconnect.spam": "Spam nedeniyle atıldı (sohbet hız sınırını yükselt)."
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

/** map low-level connection errors to actionable Turkish messages */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ECONNREFUSED")) return "Sunucuya ulaşılamadı (bağlantı reddedildi) — IP ve port doğru mu, sunucu açık mı?";
  if (msg.includes("ENOTFOUND")) return "Sunucu adresi çözümlenemedi — IP/alan adını kontrol et.";
  if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) return "Bağlantı zaman aşımına uğradı — sunucu erişilebilir mi?";
  if (msg.includes("EHOSTUNREACH")) return "Sunucuya giden ağ yolu yok (host unreachable).";
  if (msg.includes("ECONNRESET")) return "Bağlantı sunucu tarafından kesildi (connection reset).";
  if (msg.toLowerCase().includes("unsupported") && msg.toLowerCase().includes("version"))
    return `Desteklenmeyen/algılanamayan sürüm — panelden elle sürüm seçmeyi dene. (${msg})`;
  if (msg.includes("RateLimiter") || msg.includes("rate limit")) return "Sunucu bağlantı hızını sınırladı — az sonra yeniden denenecek.";
  return msg;
}

/** strip legacy §x color codes (for plain-text handling) */
export function stripLegacyCodes(s: string): string {
  return s.replace(/§[0-9a-fk-orx]/gi, "");
}

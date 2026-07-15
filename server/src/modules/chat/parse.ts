import type { ChatKind } from "../../types";

export interface ParsedChat {
  kind: ChatKind;
  username?: string;
  text: string;
}

/** strip legacy §x and some unicode private-use leftovers */
export function stripColorCodes(s: string): string {
  return s
    .replace(/§[0-9a-fk-orx]/gi, "")
    .replace(/\u00a7[0-9a-fk-orx]/gi, "")
    .replace(/\x1b\[[0-9;]*m/g, "") // ansi if any leaked into plain
    .trim();
}

/**
 * Server chat formats vary wildly (vanilla, Essentials, AuthMe, LuckPerms, custom).
 * Patterns are tried in order; anything unmatched is shown as a "server" message.
 * Add new server-specific patterns HERE only (TODO.md §12).
 */
const PATTERNS: Array<{ kind: ChatKind; re: RegExp }> = [
  // vanilla: <Name> message
  { kind: "player", re: /^<([A-Za-z0-9_]{1,16})>\s*(.*)$/s },
  // vanilla whisper
  { kind: "whisper", re: /^([A-Za-z0-9_]{1,16}) whispers(?: to you)?:\s*(.*)$/s },
  // essentials whisper: [Name -> me]
  { kind: "whisper", re: /^\[([A-Za-z0-9_]{1,16})\s*->\s*(?:me|ben|you|sen)\]\s*(.*)$/is },
  // /msg style: Name -> you: text  /  Name size fısıldıyor
  { kind: "whisper", re: /^([A-Za-z0-9_]{1,16})\s*(?:fısıldıyor|fisildiyor|whispers).*?:\s*(.*)$/is },
  // common: Name » message  /  Name › message  /  Name > message
  { kind: "player", re: /^([A-Za-z0-9_]{1,16})\s*[»›>➤→]\s*(.*)$/s },
  // LuckPerms / ranks: [Admin] Name: msg  or  [A][B] Name: msg
  { kind: "player", re: /^(?:\[[^\]]{1,32}\]\s*)+([A-Za-z0-9_]{1,16})\s*[:»›]\s*(.*)$/s },
  // (Rank) Name: message
  { kind: "player", re: /^(?:\([^)]{1,24}\)\s*)+([A-Za-z0-9_]{1,16})\s*[:»›]\s*(.*)$/s },
  // Name: message
  { kind: "player", re: /^([A-Za-z0-9_]{1,16}):\s+(.*)$/s },
  // Name | message  (some Turkish hubs)
  { kind: "player", re: /^([A-Za-z0-9_]{1,16})\s*\|\s+(.*)$/s },
  // * Name message  (me/action)
  { kind: "player", re: /^\*\s*([A-Za-z0-9_]{1,16})\s+(.*)$/s },
  // [Local] Name: message / [Global] Name »
  { kind: "player", re: /^\[[A-Za-zÇĞİÖŞÜçğıöşü]{1,16}\]\s+([A-Za-z0-9_]{1,16})\s*[:»›]\s*(.*)$/s }
];

export function parseChatMessage(plainText: string): ParsedChat {
  const plain = stripColorCodes(plainText);
  if (!plain) return { kind: "server", text: plainText };

  for (const p of PATTERNS) {
    const m = plain.match(p.re);
    if (m) return { kind: p.kind, username: m[1], text: (m[2] ?? "").trimEnd() };
  }
  return { kind: "server", text: plain };
}

/**
 * prismarine-chat / JSON component'ten oyuncu adını çek (toString() sadece metni bırakabiliyor).
 * chat.type.text with[0]=sender with[1]=body — birçok plugin/vanilla 1.16+ bu yolu kullanır.
 */
export function parseChatComponent(jsonMsg: unknown): ParsedChat | null {
  if (jsonMsg == null) return null;

  // ChatMessage instance
  const anyMsg = jsonMsg as {
    json?: unknown;
    translate?: string;
    with?: unknown[];
    text?: string;
    extra?: unknown[];
    toString?: () => string;
  };

  const root = (anyMsg.json ?? jsonMsg) as Record<string, unknown>;
  try {
    const fromStructured = fromTranslate(root) ?? fromTranslate(anyMsg as unknown as Record<string, unknown>);
    if (fromStructured) return fromStructured;

    // nested extra sometimes carries the chat line
    if (Array.isArray(root.extra)) {
      for (const part of root.extra) {
        const nested = parseChatComponent(part);
        if (nested && nested.kind === "player") return nested;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

function fromTranslate(obj: Record<string, unknown> | null | undefined): ParsedChat | null {
  if (!obj || typeof obj !== "object") return null;
  const translate = typeof obj.translate === "string" ? obj.translate : "";
  const withArr = Array.isArray(obj.with) ? obj.with : null;
  if (!withArr || withArr.length < 1) return null;

  // chat.type.text / chat.type.emote / chat.type.announcement
  if (
    translate === "chat.type.text" ||
    translate === "chat.type.emote" ||
    translate === "chat.type.announcement" ||
    translate === "chat.type.team.text" ||
    translate.endsWith("chat.type.text")
  ) {
    const username = componentToName(withArr[0]);
    const text = withArr.length >= 2 ? componentToPlain(withArr[1]) : "";
    if (username) {
      return {
        kind: translate.includes("emote") ? "player" : "player",
        username,
        text: text || componentToPlain(withArr.slice(1))
      };
    }
  }

  // commands.msg.display.* whisper variants
  if (translate.includes("commands.message") || translate.includes("commands.msg") || translate.includes("whisper")) {
    const username = componentToName(withArr[0]);
    const text = withArr.length >= 2 ? componentToPlain(withArr[withArr.length - 1]) : "";
    if (username) return { kind: "whisper", username, text };
  }

  return null;
}

function componentToName(c: unknown): string | undefined {
  if (c == null) return undefined;
  if (typeof c === "string") {
    const s = stripColorCodes(c);
    // insertion might be plain name
    const m = s.match(/^([A-Za-z0-9_]{1,16})$/);
    return m?.[1];
  }
  if (typeof c !== "object") return undefined;
  const o = c as Record<string, unknown>;
  // player name often in insertion or text
  if (typeof o.insertion === "string") {
    const m = stripColorCodes(o.insertion).match(/^([A-Za-z0-9_]{1,16})$/);
    if (m) return m[1];
  }
  if (typeof o.text === "string") {
    const s = stripColorCodes(o.text);
    const m = s.match(/^([A-Za-z0-9_]{1,16})$/);
    if (m) return m[1];
    // "Name: " prefix
    const m2 = s.match(/^([A-Za-z0-9_]{1,16})\s*:?\s*$/);
    if (m2) return m2[1];
  }
  if (o.hoverEvent && typeof o.hoverEvent === "object") {
    const he = o.hoverEvent as { contents?: unknown; value?: unknown };
    const contents = he.contents ?? he.value;
    if (typeof contents === "string") {
      try {
        const j = JSON.parse(contents);
        if (j?.name) return String(j.name).slice(0, 16);
      } catch {
        const m = stripColorCodes(contents).match(/([A-Za-z0-9_]{1,16})/);
        if (m) return m[1];
      }
    }
    if (contents && typeof contents === "object" && "name" in (contents as object)) {
      return String((contents as { name: string }).name).replace(/[^A-Za-z0-9_]/g, "").slice(0, 16) || undefined;
    }
  }
  if (Array.isArray(o.extra)) {
    for (const p of o.extra) {
      const n = componentToName(p);
      if (n) return n;
    }
  }
  // last resort: flatten and take first token that looks like MC name
  const flat = componentToPlain(c);
  const m = flat.match(/^([A-Za-z0-9_]{1,16})\b/);
  return m?.[1];
}

function componentToPlain(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return stripColorCodes(c);
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  if (Array.isArray(c)) return c.map(componentToPlain).join("");
  if (typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (typeof (o as { toString?: () => string }).toString === "function" && o.json !== undefined) {
      try {
        const s = String(c);
        if (s && s !== "[object Object]") return stripColorCodes(s);
      } catch {
        /* */
      }
    }
    let out = "";
    if (typeof o.text === "string") out += o.text;
    if (Array.isArray(o.extra)) out += o.extra.map(componentToPlain).join("");
    if (Array.isArray(o.with) && !out) out += o.with.map(componentToPlain).join(" ");
    return stripColorCodes(out);
  }
  return stripColorCodes(String(c));
}

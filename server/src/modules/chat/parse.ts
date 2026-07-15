import type { ChatKind } from "../../types";

export interface ParsedChat {
  kind: ChatKind;
  username?: string;
  text: string;
}

/** strip legacy §x / ansi leftovers */
export function stripColorCodes(s: string): string {
  return s
    .replace(/§[0-9a-fk-orx]/gi, "")
    .replace(/\u00a7[0-9a-fk-orx]/gi, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
}

const MC_NAME = "[A-Za-z0-9_]{1,16}";

/**
 * Plugin/vanilla düz metin formatları.
 * Sunucu prefix'i değişse de olabildiğince esnek (rank, kanal, oklar…).
 */
const PATTERNS: Array<{ kind: ChatKind; re: RegExp }> = [
  { kind: "player", re: new RegExp(`^<(${MC_NAME})>\\s*(.*)$`, "s") },
  { kind: "whisper", re: new RegExp(`^(${MC_NAME}) whispers(?: to you)?:\\s*(.*)$`, "s") },
  { kind: "whisper", re: new RegExp(`^\\[(${MC_NAME})\\s*->\\s*(?:me|ben|you|sen)\\]\\s*(.*)$`, "is") },
  { kind: "whisper", re: new RegExp(`^(${MC_NAME})\\s*(?:fısıldıyor|fisildiyor|whispers).*?:\\s*(.*)$`, "is") },
  // Name » msg / Name > msg / Name → msg
  { kind: "player", re: new RegExp(`^(${MC_NAME})\\s*[»›>➤→\\-:~]+\\s*(.*)$`, "s") },
  // [rank]… Name: msg
  { kind: "player", re: new RegExp(`^(?:\\[[^\\]]{1,40}\\]\\s*)+(${MC_NAME})\\s*[:»›]\\s*(.*)$`, "s") },
  // (rank) Name: msg
  { kind: "player", re: new RegExp(`^(?:\\([^)]{1,32}\\)\\s*)+(${MC_NAME})\\s*[:»›]\\s*(.*)$`, "s") },
  // emoji/channel prefix: 💬 [Admin] Name » msg  — name near end before separator
  { kind: "player", re: new RegExp(`(?:^|\\s)(${MC_NAME})\\s*[»›>:\\|]\\s*(.+)$`, "s") },
  // Name: message
  { kind: "player", re: new RegExp(`^(${MC_NAME}):\\s+(.*)$`, "s") },
  // Name | message
  { kind: "player", re: new RegExp(`^(${MC_NAME})\\s*\\|\\s+(.*)$`, "s") },
  // * Name does something
  { kind: "player", re: new RegExp(`^\\*\\s*(${MC_NAME})\\s+(.*)$`, "s") },
  // [Global] Name: msg
  { kind: "player", re: new RegExp(`^\\[[^\\]]{1,20}\\]\\s+(${MC_NAME})\\s*[:»›]\\s*(.*)$`, "s") }
];

export function parseChatMessage(plainText: string): ParsedChat {
  const plain = stripColorCodes(plainText);
  if (!plain) return { kind: "server", text: plainText };

  for (const p of PATTERNS) {
    const m = plain.match(p.re);
    if (m?.[1]) return { kind: p.kind, username: m[1], text: (m[2] ?? "").trimEnd() };
  }
  return { kind: "server", text: plain };
}

/**
 * Öğrenilmiş önek: "….Name » " gibi kalıpları sonradan uygula.
 * pattern örnek: /^(?:\[Vip\]\s*)?Name\s*»\s*(.*)$/i  — biz string template tutarız
 */
export function applyLearnedPrefix(plain: string, username: string, bodyHint?: string): ParsedChat | null {
  const p = stripColorCodes(plain);
  const u = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Name … message  (name appears then separator then rest)
  const re = new RegExp(`^(?:.*?)\\b(${u})\\b\\s*[:»›>➤→\\-|~]*\\s*(.*)$`, "is");
  const m = p.match(re);
  if (m) {
    const text = (m[2] ?? "").trim();
    if (bodyHint && text && !text.includes(bodyHint) && bodyHint.length > 0) {
      // prefer body hint if parse looks wrong
      return { kind: "player", username, text: bodyHint };
    }
    return { kind: "player", username, text: text || bodyHint || p };
  }
  if (bodyHint && (p === bodyHint || p.endsWith(bodyHint))) {
    return { kind: "player", username, text: bodyHint };
  }
  return null;
}

/**
 * prismarine-chat component + 1.19+ client-side format (translate with sender/content).
 */
export function parseChatComponent(jsonMsg: unknown): ParsedChat | null {
  if (jsonMsg == null) return null;

  const anyMsg = jsonMsg as {
    json?: unknown;
    translate?: string;
    with?: unknown[];
    text?: string;
    extra?: unknown[];
    unsigned?: unknown;
  };

  // unsigned content sometimes has different body
  const roots = [anyMsg.json, jsonMsg, anyMsg.unsigned].filter(Boolean) as unknown[];

  for (const root of roots) {
    try {
      const r = root as Record<string, unknown>;
      const fromStructured = fromTranslate(r) ?? fromTranslate(anyMsg as unknown as Record<string, unknown>);
      if (fromStructured?.username) return fromStructured;

      const fromClick = fromClickSuggest(r);
      if (fromClick?.username) {
        // body = full plain minus name decoration
        const plain = componentToPlain(r);
        const learned = applyLearnedPrefix(plain, fromClick.username);
        if (learned) return learned;
        return { kind: "player", username: fromClick.username, text: stripNameDecor(plain, fromClick.username) };
      }

      if (Array.isArray(r.extra)) {
        for (const part of r.extra) {
          const nested = parseChatComponent(part);
          if (nested?.username) return nested;
        }
      }

      // flat walk: find first name-like clickable part + remaining text
      const walked = walkExtraForPlayer(r);
      if (walked) return walked;
    } catch {
      /* next root */
    }
  }
  return null;
}

function fromTranslate(obj: Record<string, unknown> | null | undefined): ParsedChat | null {
  if (!obj || typeof obj !== "object") return null;
  const translate = typeof obj.translate === "string" ? obj.translate : "";
  const withArr = Array.isArray(obj.with) ? obj.with : null;
  if (!withArr?.length) return null;

  // printf-style client formats: often sender + content as last two params
  // e.g. "<%s> %s", "[%s] %s » %s"
  if (translate.includes("%s") || translate.includes("%1$s") || translate.startsWith("chat.type.") || translate.includes("chat.type")) {
    // prefer known chat.type.text layout
    if (
      translate === "chat.type.text" ||
      translate === "chat.type.emote" ||
      translate === "chat.type.announcement" ||
      translate === "chat.type.team.text" ||
      translate.endsWith("chat.type.text")
    ) {
      const username = componentToName(withArr[0]);
      const text = withArr.length >= 2 ? componentToPlain(withArr[1]) : "";
      if (username) return { kind: "player", username, text: text || componentToPlain(withArr.slice(1)) };
    }

    // generic printf: gönderen genelde son parametre DEĞİL (son = içerik)
    // isim: son hariç ilk bulunan name-like; yoksa ilk slot
    let username: string | undefined;
    for (let i = 0; i < Math.max(0, withArr.length - 1); i++) {
      const n = componentToName(withArr[i]);
      if (n) {
        username = n;
        // rank + name sırasında son name-like'ı tut (Admin, Player → Player)
      }
    }
    if (!username && withArr.length === 1) username = componentToName(withArr[0]);
    if (username) {
      const text = componentToPlain(withArr[withArr.length - 1]);
      return { kind: "player", username, text };
    }
  }

  if (translate.includes("commands.message") || translate.includes("commands.msg") || translate.toLowerCase().includes("whisper")) {
    const username = componentToName(withArr[0]);
    const text = componentToPlain(withArr[withArr.length - 1]);
    if (username) return { kind: "whisper", username, text };
  }

  return null;
}

function fromClickSuggest(obj: Record<string, unknown>): { username: string } | null {
  const n = nameFromClick(obj);
  if (n) return { username: n };
  if (Array.isArray(obj.extra)) {
    for (const p of obj.extra) {
      if (p && typeof p === "object") {
        const r = fromClickSuggest(p as Record<string, unknown>);
        if (r) return r;
      }
    }
  }
  if (Array.isArray(obj.with)) {
    for (const p of obj.with) {
      if (p && typeof p === "object") {
        const r = fromClickSuggest(p as Record<string, unknown>);
        if (r) return r;
      }
    }
  }
  return null;
}

function nameFromClick(o: Record<string, unknown>): string | undefined {
  const ce = o.clickEvent as { action?: string; value?: string } | undefined;
  if (ce?.value && (ce.action === "suggest_command" || ce.action === "run_command")) {
    // /msg Name  /  /tell Name  /  /w Name
    const m = ce.value.match(/^\/(?:msg|tell|w|minecraft:msg|minecraft:tell)\s+([A-Za-z0-9_]{1,16})\b/i);
    if (m) return m[1];
  }
  return undefined;
}

function walkExtraForPlayer(obj: Record<string, unknown>): ParsedChat | null {
  const flat: Array<{ name?: string; text: string }> = [];
  const visit = (c: unknown) => {
    if (c == null) return;
    if (typeof c === "string") {
      flat.push({ text: stripColorCodes(c) });
      return;
    }
    if (typeof c !== "object") return;
    const o = c as Record<string, unknown>;
    const name = componentToName(o) ?? nameFromClick(o);
    const text = typeof o.text === "string" ? stripColorCodes(o.text) : "";
    if (name || text) flat.push({ name, text });
    if (Array.isArray(o.extra)) o.extra.forEach(visit);
    if (Array.isArray(o.with)) o.with.forEach(visit);
  };
  visit(obj);
  const namePart = [...flat].reverse().find((p) => p.name);
  if (!namePart?.name) return null;
  // text = parts after the name part joined, or everything that isn't pure name decoration
  const idx = flat.lastIndexOf(namePart);
  const after = flat
    .slice(idx + 1)
    .map((p) => p.text)
    .join("")
    .replace(/^[\s:»›>|·\-]+/, "")
    .trim();
  if (after) return { kind: "player", username: namePart.name, text: after };
  return null;
}

export function componentToName(c: unknown): string | undefined {
  if (c == null) return undefined;
  if (typeof c === "string") {
    const s = stripColorCodes(c);
    const m = s.match(new RegExp(`^(${MC_NAME})$`));
    return m?.[1];
  }
  if (typeof c !== "object") return undefined;
  const o = c as Record<string, unknown>;

  const fromClick = nameFromClick(o);
  if (fromClick) return fromClick;

  if (typeof o.insertion === "string") {
    const m = stripColorCodes(o.insertion).match(new RegExp(`^(${MC_NAME})$`));
    if (m) return m[1];
  }
  if (typeof o.text === "string") {
    const s = stripColorCodes(o.text);
    const m = s.match(new RegExp(`^(${MC_NAME})$`));
    if (m) return m[1];
    const m2 = s.match(new RegExp(`^(${MC_NAME})\\s*:?\\s*$`));
    if (m2) return m2[1];
  }
  // hover show_entity
  if (o.hoverEvent && typeof o.hoverEvent === "object") {
    const he = o.hoverEvent as { contents?: unknown; value?: unknown; action?: string };
    let contents = he.contents ?? he.value;
    if (typeof contents === "string") {
      const raw = contents;
      try {
        contents = JSON.parse(raw);
      } catch {
        const m = stripColorCodes(raw).match(new RegExp(`(${MC_NAME})`));
        if (m) return m[1];
      }
    }
    if (contents && typeof contents === "object") {
      const co = contents as { name?: unknown; id?: string; type?: string };
      if (co.name) {
        if (typeof co.name === "string") {
          try {
            const j = JSON.parse(co.name);
            if (j?.text) return stripColorCodes(String(j.text)).replace(/[^A-Za-z0-9_]/g, "").slice(0, 16) || undefined;
          } catch {
            /* */
          }
          return stripColorCodes(co.name).replace(/[^A-Za-z0-9_]/g, "").slice(0, 16) || undefined;
        }
        if (typeof co.name === "object" && co.name && "text" in (co.name as object)) {
          return stripColorCodes(String((co.name as { text: string }).text))
            .replace(/[^A-Za-z0-9_]/g, "")
            .slice(0, 16) || undefined;
        }
      }
    }
  }
  if (Array.isArray(o.extra)) {
    for (const p of o.extra) {
      const n = componentToName(p);
      if (n) return n;
    }
  }
  if (Array.isArray(o.with)) {
    for (const p of o.with) {
      const n = componentToName(p);
      if (n) return n;
    }
  }
  return undefined;
}

export function componentToPlain(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return stripColorCodes(c);
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  if (Array.isArray(c)) return c.map(componentToPlain).join("");
  if (typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (typeof (o as { toString?: () => string }).toString === "function" && (o.json !== undefined || o.translate !== undefined || o.text !== undefined)) {
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

function stripNameDecor(plain: string, username: string): string {
  const u = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return plain
    .replace(new RegExp(`^.*\\b${u}\\b\\s*[:»›>➤→\\-|~]*\\s*`, "i"), "")
    .trim() || plain;
}

/**
 * UUID (string / buffer-like) → tab listesinden isim.
 */
export function resolveUsernameFromSender(
  sender: unknown,
  players: Record<string, { uuid?: string } | undefined> | undefined
): string | undefined {
  if (sender == null || !players) return undefined;
  let uuid = "";
  if (typeof sender === "string") uuid = sender.replace(/-/g, "").toLowerCase();
  else if (Buffer.isBuffer(sender)) uuid = sender.toString("hex").toLowerCase();
  else if (Array.isArray(sender)) {
    // int array uuid
    try {
      const buf = Buffer.alloc(16);
      sender.forEach((num: number, i: number) => buf.writeInt32BE(num, i * 4));
      uuid = buf.toString("hex").toLowerCase();
    } catch {
      return undefined;
    }
  } else if (typeof sender === "object" && sender && "toString" in sender) {
    uuid = String(sender).replace(/-/g, "").toLowerCase();
  }
  if (!uuid || uuid === "0".repeat(32) || uuid.includes("undefined")) return undefined;

  for (const [name, p] of Object.entries(players)) {
    const pu = (p?.uuid ?? "").replace(/-/g, "").toLowerCase();
    if (pu && pu === uuid) return name;
  }
  return undefined;
}

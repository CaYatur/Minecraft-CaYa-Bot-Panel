import type { ChatKind } from "../../types";

export interface ParsedChat {
  kind: ChatKind;
  username?: string;
  text: string;
  /** isimden önce görünen rütbe/prefix/kmainl: "[Admin] [VIP] " */
  prefix?: string;
  /** isimden sonra, mesajdan önce: " » " / ": " */
  nameSuffix?: string;
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
 * AuthMe / join-leave / hoş geldin / sunucu duyurusu — oyuncu sohbeti DEĞİL.
 * Bunlar isim içerse bile (tıklmainbilir prefix) sunucu mesajı kalmalı.
 */
export function isLikelySystemMessage(plainText: string): boolean {
  const p = stripColorCodes(plainText);
  if (!p) return true;

  // AuthMe / login eklentileri
  if (
    /\/login\b|\/register\b|\/reg\b|\/l\b|authme|loginsecurity|nlogin/i.test(p) ||
    /lütfen.{0,40}(giriş|login|şifre|sifre)/i.test(p) ||
    /please.{0,40}(login|register|log in)/i.test(p) ||
    /başarıyla\s+giriş|basariyla\s+giris|successfully\s+logged|logged\s+in\s+successfully/i.test(p) ||
    /giriş\s+yaptınız|giris\s+yaptiniz|wrong\s+password|yanlış\s+şifre|yanlis\s+sifre/i.test(p) ||
    /entries\s+ol|kayit\s+ol|not\s+registered|unregister/i.test(p)
  ) {
    return true;
  }

  // Join / leave / welcome
  if (
    /hoş\s*geldin|hos\s*geldin|hoşgeldin|welcome\s+to\b/i.test(p) ||
    /\bjoined the game\b|\bleft the game\b|\bhas joined\b|\bhas left\b/i.test(p) ||
    /sunucuya\s+(katıl|girdi|giriş|bagland|bağland)/i.test(p) ||
    /oyundan\s+ayrıl|sunucudan\s+ayrıl|disconnected/i.test(p)
  ) {
    return true;
  }

  // İstatistik / panel satırları: "hesaplar:2" "online: 5"
  if (/^(hesaplar|online|oyuncu|players?|tps|ms)\s*:\s*[\d./]+$/i.test(p)) return true;

  // Saf sunucu duyurusu kalıpları
  if (/^\[(Server|Sunucu|SYSTEM|Konsol|Console)\]/i.test(p)) return true;

  return false;
}

/**
 * Ayrıştırılmış "oyuncu mesaj gövdesi" gerçek sohbet mi?
 * "."  /  "! Hoş geldin."  gibi kalıntıları reddet.
 */
export function isValidPlayerChatBody(text: string, plainFull?: string): boolean {
  if (plainFull && isLikelySystemMessage(plainFull)) return false;
  const t = (text ?? "").trim();
  if (!t) return false;
  // yalnızca noktalama / boşluk
  if (/^[.!?,;:…·•\-\s¡!]+$/u.test(t)) return false;
  // "! Hoş geldin" kalıntısı
  if (/^[!¡.]\s*(hoş|hos)\s*geld/i.test(t)) return false;
  if (/^(hoş|hos)\s*geldin/i.test(t) && t.length < 40) return false;
  // tek karakter + sistemik noktalama (gerçek "sa" / "as" OK)
  if (t.length === 1 && /[^A-Za-z0-9ğüşıöçĞÜŞİÖÇ]/.test(t)) return false;
  return true;
}

/**
 * Plugin/vanilla düz metin formatları.
 * Sunucu prefix'i değişse de olabildiğince esnek (rank, kmainl, oklar…).
 * Not: çok gevşek kalıplar sistem mesajını oyuncuya bağlar → isLikelySystemMessage önce.
 */
const PATTERNS: Array<{ kind: ChatKind; re: RegExp }> = [
  { kind: "player", re: new RegExp(`^<(${MC_NAME})>\\s*(.*)$`, "s") },
  { kind: "whisper", re: new RegExp(`^(${MC_NAME}) whispers(?: to you)?:\\s*(.*)$`, "s") },
  { kind: "whisper", re: new RegExp(`^\\[(${MC_NAME})\\s*->\\s*(?:me|ben|you|sen)\\]\\s*(.*)$`, "is") },
  { kind: "whisper", re: new RegExp(`^(${MC_NAME})\\s*(?:whispers|whispers|whispers).*?:\\s*(.*)$`, "is") },
  // Name » msg / Name > msg / Name → msg  (en az bir ayırıcı karakter, boş mesaj yok)
  { kind: "player", re: new RegExp(`^(${MC_NAME})\\s*[»›➤→]+\\s*(.+)$`, "s") },
  // Name > msg (tek > ama boşluksuz sayılar "a>b" plugin kmainlı)
  { kind: "player", re: new RegExp(`^(${MC_NAME})\\s*>\\s+(.+)$`, "s") },
  // [rank]… Name: msg
  { kind: "player", re: new RegExp(`^(?:\\[[^\\]]{1,40}\\]\\s*)+(${MC_NAME})\\s*[:»›]\\s+(.+)$`, "s") },
  // (rank) Name: msg
  { kind: "player", re: new RegExp(`^(?:\\([^)]{1,32}\\)\\s*)+(${MC_NAME})\\s*[:»›]\\s+(.+)$`, "s") },
  // [Global] Name: msg
  { kind: "player", re: new RegExp(`^\\[[^\\]]{1,20}\\]\\s+(${MC_NAME})\\s*[:»›]\\s+(.+)$`, "s") },
  // Name: message  — iki nokta sonrası BOŞLUK zorunlu (hesaplar:2 elensin)
  { kind: "player", re: new RegExp(`^(${MC_NAME}):\\s+(.+)$`, "s") },
  // Name | message
  { kind: "player", re: new RegExp(`^(${MC_NAME})\\s*\\|\\s+(.+)$`, "s") },
  // * Name does something
  { kind: "player", re: new RegExp(`^\\*\\s*(${MC_NAME})\\s+(.+)$`, "s") }
];

export function parseChatMessage(plainText: string): ParsedChat {
  const plain = stripColorCodes(plainText);
  if (!plain) return { kind: "server", text: plainText };

  if (isLikelySystemMessage(plain)) {
    return { kind: "server", text: plain };
  }

  for (const p of PATTERNS) {
    const m = plain.match(p.re);
    if (m?.[1]) {
      const username = m[1];
      const text = (m[2] ?? "").trimEnd();
      if (!isValidPlayerChatBody(text, plain)) continue;
      const decor = extractNameDecor(plain, username, text);
      return { kind: p.kind, username, text, prefix: decor.prefix, nameSuffix: decor.nameSuffix };
    }
  }
  return { kind: "server", text: plain };
}

/**
 * Düz satırdan rütbe/prefix ve ayırıcıyı çıkar.
 * Örn: "[Admin] [VIP] Steve » merhaba" → prefix="[Admin] [VIP] ", nameSuffix=" » ", body=merhaba
 */
/**
 * Tab listesi displayName'den rütbe prefix'i: "[Kurucu] CaYatur" → prefix "[Kurucu] "
 */
export function prefixFromDisplayName(displayName: string | undefined, username: string): string {
  if (!displayName) return "";
  const plain = stripColorCodes(displayName);
  if (!plain) return "";
  const u = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // displayName sonunda veya forde username
  const re = new RegExp(`^(.*?)\\b${u}\\b\\s*$`, "i");
  const m = plain.match(re);
  if (m) {
    let prefix = (m[1] ?? "").trimEnd();
    if (prefix && !prefix.endsWith(" ")) prefix += " ";
    return prefix;
  }
  // displayName = sadece rütbe + isim bitişik: "[Kurucu]Name"
  const re2 = new RegExp(`^(.*)${u}\\s*$`, "i");
  const m2 = plain.match(re2);
  if (m2 && m2[1] && m2[1] !== plain) {
    let prefix = m2[1].trimEnd();
    if (prefix && !prefix.endsWith(" ")) prefix += " ";
    // isimle aynıysa prefix yok
    if (prefix.toLowerCase().includes(username.toLowerCase()) && prefix.length < username.length + 2) return "";
    return prefix;
  }
  return "";
}

/** ANSI / full satır gerçekten isim içeriyor mu? (sadece gövde mi) */
export function lineIncludesUsername(line: string | undefined, username: string | undefined): boolean {
  if (!line || !username) return false;
  const plain = stripColorCodes(line).toLowerCase();
  return plain.includes(username.toLowerCase());
}

export function extractNameDecor(
  plainFull: string,
  username: string,
  bodyHint?: string
): { prefix: string; nameSuffix: string; body: string } {
  const plain = stripColorCodes(plainFull);
  const u = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // vanilla <Name> body
  const vanilla = plain.match(new RegExp(`^<${u}>\\s*(.*)$`, "is"));
  if (vanilla) {
    return { prefix: "", nameSuffix: " ", body: (vanilla[1] ?? bodyHint ?? "").trim() };
  }

  // [rank]… Name separator body — prefix is everything before name
  const re = new RegExp(`^(.*?)\\b(${u})\\b\\s*([:»›➤→|~\\-]{1,3})\\s*`, "i");
  const m = plain.match(re);
  if (!m) {
    return { prefix: "", nameSuffix: ": ", body: (bodyHint ?? plain).trim() };
  }
  let prefix = (m[1] ?? "").trimEnd();
  if (prefix && !prefix.endsWith(" ")) prefix = prefix + " ";
  // tek başına "< " veya bozuk açı parantezi temizle
  if (/^<\s*$/.test(prefix) || prefix === "< ") prefix = "";
  const sep = (m[3] ?? ":").trim();
  const nameSuffix = ` ${sep} `;
  let body = plain.slice(m[0].length).trim();
  if (bodyHint && bodyHint.length >= body.length && plain.includes(bodyHint)) {
    body = bodyHint.trim();
  }
  return {
    prefix,
    nameSuffix,
    body: body || (bodyHint ?? "").trim()
  };
}

/**
 * Öğrenilmiş önek: "….Name » " gibi kalıpları sonradan uygula.
 */
export function applyLearnedPrefix(plain: string, username: string, bodyHint?: string): ParsedChat | null {
  const p = stripColorCodes(plain);
  if (isLikelySystemMessage(p)) return null;

  const u = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // İsim satırın sonuna yakın + net ayırıcı (çok gevşek .*? Name kaldırıldı)
  const re = new RegExp(
    `^(?:\\[[^\\]]{0,40}\\]\\s*|\\([^)]{0,32}\\)\\s*|[^A-Za-z0-9_]{0,8})*\\b(${u})\\b\\s*[:»›>➤→|~\\-]{1,3}\\s*(.*)$`,
    "is"
  );
  const m = p.match(re);
  if (m) {
    let text = (m[2] ?? "").trim();
    if (bodyHint && text && !text.includes(bodyHint) && bodyHint.length > 2 && isValidPlayerChatBody(bodyHint, p)) {
      text = bodyHint;
    }
    if (!isValidPlayerChatBody(text || bodyHint || "", p)) return null;
    return { kind: "player", username, text: text || bodyHint || "" };
  }
  if (bodyHint && isValidPlayerChatBody(bodyHint, p) && (p === bodyHint || p.endsWith(bodyHint))) {
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

  const roots = [anyMsg.json, jsonMsg, anyMsg.unsigned].filter(Boolean) as unknown[];

  for (const root of roots) {
    try {
      const r = root as Record<string, unknown>;
      const plainPreview = componentToPlain(r);
      if (plainPreview && isLikelySystemMessage(plainPreview)) {
        return { kind: "server", text: plainPreview };
      }

      const fromStructured = fromTranslate(r) ?? fromTranslate(anyMsg as unknown as Record<string, unknown>);
      if (fromStructured) {
        if (fromStructured.kind === "server") return fromStructured;
        if (fromStructured.username && isValidPlayerChatBody(fromStructured.text, plainPreview || fromStructured.text)) {
          return fromStructured;
        }
      }

      const fromClick = fromClickSuggest(r);
      if (fromClick?.username) {
        const plain = componentToPlain(r);
        if (isLikelySystemMessage(plain)) return { kind: "server", text: plain };
        const learned = applyLearnedPrefix(plain, fromClick.username);
        if (learned && isValidPlayerChatBody(learned.text, plain)) return learned;
        const stripped = stripNameDecor(plain, fromClick.username);
        if (isValidPlayerChatBody(stripped, plain)) {
          return { kind: "player", username: fromClick.username, text: stripped };
        }
        // tıklmainbilir isim var ama gövde sistem/boş → sunucu
        return { kind: "server", text: plain };
      }

      if (Array.isArray(r.extra)) {
        for (const part of r.extra) {
          const nested = parseChatComponent(part);
          if (nested?.kind === "server") continue;
          if (nested?.username && isValidPlayerChatBody(nested.text, plainPreview)) return nested;
        }
      }

      const walked = walkExtraForPlayer(r);
      if (walked?.username && isValidPlayerChatBody(walked.text, plainPreview)) return walked;
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

  // duyuru / sistem — oyuncu sohbeti değil
  if (
    translate === "chat.type.announcement" ||
    translate.includes("chat.type.announcement") ||
    translate.includes("multiplayer.player.joined") ||
    translate.includes("multiplayer.player.left") ||
    translate.includes("chat.type.admin")
  ) {
    return { kind: "server", text: componentToPlain(obj) };
  }

  if (translate.includes("%s") || translate.includes("%1$s") || translate.startsWith("chat.type.") || translate.includes("chat.type")) {
    if (
      translate === "chat.type.text" ||
      translate === "chat.type.emote" ||
      translate === "chat.type.team.text" ||
      translate.endsWith("chat.type.text")
    ) {
      const username = componentToName(withArr[0]);
      const text = withArr.length >= 2 ? componentToPlain(withArr[1]) : "";
      if (username && isValidPlayerChatBody(text || componentToPlain(withArr.slice(1)))) {
        return { kind: "player", username, text: text || componentToPlain(withArr.slice(1)) };
      }
      return null;
    }

    let username: string | undefined;
    for (let i = 0; i < Math.max(0, withArr.length - 1); i++) {
      const n = componentToName(withArr[i]);
      if (n) username = n;
    }
    if (!username && withArr.length === 1) username = componentToName(withArr[0]);
    if (username) {
      const text = componentToPlain(withArr[withArr.length - 1]);
      if (!isValidPlayerChatBody(text)) return null;
      return { kind: "player", username, text };
    }
  }

  if (translate.includes("commands.message") || translate.includes("commands.msg") || translate.toLowerCase().includes("whisper")) {
    const username = componentToName(withArr[0]);
    const text = componentToPlain(withArr[withArr.length - 1]);
    if (username && isValidPlayerChatBody(text)) return { kind: "whisper", username, text };
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
  const idx = flat.lastIndexOf(namePart);
  const after = flat
    .slice(idx + 1)
    .map((p) => p.text)
    .join("")
    .replace(/^[\s:»›>|·\-!.]+/, "")
    .trim();
  if (after && isValidPlayerChatBody(after)) return { kind: "player", username: namePart.name, text: after };
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
          return (
            stripColorCodes(String((co.name as { text: string }).text))
              .replace(/[^A-Za-z0-9_]/g, "")
              .slice(0, 16) || undefined
          );
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
    if (
      typeof (o as { toString?: () => string }).toString === "function" &&
      (o.json !== undefined || o.translate !== undefined || o.text !== undefined)
    ) {
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
  return (
    plain
      .replace(new RegExp(`^.*\\b${u}\\b\\s*[:»›>➤→\\-|~!.]*\\s*`, "i"), "")
      .trim() || plain
  );
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

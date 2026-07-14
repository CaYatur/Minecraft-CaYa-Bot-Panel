import type { ChatKind } from "../../types";

export interface ParsedChat {
  kind: ChatKind;
  username?: string;
  text: string;
}

/**
 * Server chat formats vary wildly (vanilla, Essentials, custom plugins).
 * Patterns are tried in order; anything unmatched is shown as a "server" message.
 * Add new server-specific patterns HERE only (TODO.md §12).
 */
const PATTERNS: Array<{ kind: ChatKind; re: RegExp }> = [
  // vanilla: <Name> message
  { kind: "player", re: /^<([A-Za-z0-9_]{1,16})>\s(.*)$/s },
  // vanilla whisper: Name whispers to you: message
  { kind: "whisper", re: /^([A-Za-z0-9_]{1,16}) whispers(?: to you)?:\s(.*)$/s },
  // essentials whisper: [Name -> me] message / [Name -> ben] message
  { kind: "whisper", re: /^\[([A-Za-z0-9_]{1,16}) -> (?:me|ben)\]\s(.*)$/is },
  // common plugin format: Name » message  /  Name > message
  { kind: "player", re: /^([A-Za-z0-9_]{1,16})\s?[»>]\s(.*)$/s },
  // prefixed plugin format: [Rank][X] Name: message (one or more [..] groups)
  { kind: "player", re: /^(?:\[[^\]]{1,24}\]\s*)+([A-Za-z0-9_]{1,16})\s*[:»]\s(.*)$/s },
  // plain colon format: Name: message (last resort before "server")
  { kind: "player", re: /^([A-Za-z0-9_]{1,16}):\s(.*)$/s }
];

export function parseChatMessage(plainText: string): ParsedChat {
  for (const p of PATTERNS) {
    const m = plainText.match(p.re);
    if (m) return { kind: p.kind, username: m[1], text: m[2] ?? "" };
  }
  return { kind: "server", text: plainText };
}

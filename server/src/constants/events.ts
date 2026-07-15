/**
 * All Socket.IO event names live here — both sides must import from a single
 * constants file (web-side mirror: web/src/lib/events.ts, keep in sync).
 */
export const EV = {
  // server -> panel
  STATE_SNAPSHOT: "state:snapshot",
  BOT_STATUS: "bot:status",
  BOT_VITALS: "bot:vitals",
  BOT_POSITION: "bot:position",
  BOT_CHAT: "bot:chat",
  BOT_CHAT_QUEUE: "bot:chatQueue",
  BOT_LOG: "bot:log",
  BOT_INVENTORY: "bot:inventory",
  BOT_TASK: "bot:task",
  BOT_COMBAT: "bot:combat",
  PANEL_NOTIFY: "panel:notify",

  // panel -> server
  SEND_CHAT: "bot:sendChat",
  BOT_ACTION: "bot:action"
} as const;

export type EventName = (typeof EV)[keyof typeof EV];

// server/src/constants/events.ts aynası — senkron tut!
export const EV = {
  STATE_SNAPSHOT: "state:snapshot",
  BOT_STATUS: "bot:status",
  BOT_VITALS: "bot:vitals",
  BOT_POSITION: "bot:position",
  BOT_CHAT: "bot:chat",
  BOT_CHAT_QUEUE: "bot:chatQueue",
  BOT_LOG: "bot:log",
  BOT_INVENTORY: "bot:inventory",
  BOT_TASK: "bot:task",
  PANEL_NOTIFY: "panel:notify",
  SEND_CHAT: "bot:sendChat",
  BOT_ACTION: "bot:action"
} as const;

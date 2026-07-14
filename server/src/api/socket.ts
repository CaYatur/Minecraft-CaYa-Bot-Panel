import type { Server } from "socket.io";
import { EV } from "../constants/events";
import type { BotInstance } from "../core/BotInstance";
import type { BotManager } from "../core/BotManager";
import { createLogger, logHub } from "../utils/logger";

const log = createLogger("socket");

export function setupSocket(io: Server, manager: BotManager, supportedVersions: string[]) {
  const broadcastSnapshot = () => io.emit(EV.STATE_SNAPSHOT, manager.snapshot(supportedVersions));

  const wireInstance = (inst: BotInstance) => {
    inst.on("status", (p) => io.emit(EV.BOT_STATUS, p));
    inst.on("vitals", (p) => io.emit(EV.BOT_VITALS, p));
    inst.on("position", (p) => io.emit(EV.BOT_POSITION, p));
    inst.on("chat", (e) => io.emit(EV.BOT_CHAT, e));
    inst.on("chatQueue", (length: number) => io.emit(EV.BOT_CHAT_QUEUE, { botId: inst.config.id, length }));
  };

  for (const inst of manager.bots.values()) wireInstance(inst);
  manager.on("botAdded", (inst: BotInstance) => {
    wireInstance(inst);
    broadcastSnapshot();
  });
  manager.on("botRemoved", () => broadcastSnapshot());
  // sunucu profili CRUD + config değişimleri de tüm panellere anında yansır
  manager.on("changed", () => broadcastSnapshot());

  // İ1: tüm loglar canlı olarak panele akar
  logHub.addSink((entry) => io.emit(EV.BOT_LOG, entry));

  io.on("connection", (socket) => {
    log.debug(`Panel bağlandı (${socket.id})`);
    socket.emit(EV.STATE_SNAPSHOT, manager.snapshot(supportedVersions));

    socket.on(EV.SEND_CHAT, (payload: { botId?: string; text?: string }) => {
      const inst = payload?.botId ? manager.get(payload.botId) : undefined;
      const text = String(payload?.text ?? "").trim();
      if (inst && text) inst.sendChat(text);
    });

    socket.on(EV.BOT_ACTION, (payload: { botId?: string; type?: string }) => {
      // Faz 4+ ile genişler (goto/follow/stop...). Şimdilik start/stop.
      const inst = payload?.botId ? manager.get(payload.botId) : undefined;
      if (!inst) return;
      if (payload.type === "start") inst.start();
      else if (payload.type === "stop") inst.stop();
    });

    socket.on("disconnect", () => log.debug(`Panel ayrıldı (${socket.id})`));
  });
}

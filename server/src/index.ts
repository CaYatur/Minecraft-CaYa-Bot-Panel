import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { Server as SocketServer } from "socket.io";
import { createRestRouter, restErrorHandler } from "./api/rest";
import { setupSocket } from "./api/socket";
import { WEB_DIST_DIR } from "./config/paths";
import { BotManager } from "./core/BotManager";
import { createLogger } from "./utils/logger";

const PORT = Number(process.env.CAYA_PORT || 3001);
const HOST = process.env.CAYA_HOST || "127.0.0.1"; // güvenlik: varsayılan sadece localhost

const log = createLogger("server");

// mineflayer'ın test edilen sürüm listesi (panelde sürüm seçiciyi besler)
function readSupportedVersions(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mf = require("mineflayer");
    const list: unknown = mf.testedVersions ?? mf.supportedVersions;
    if (Array.isArray(list)) return list.map(String);
  } catch {
    /* fallback below */
  }
  return ["1.8.9", "1.12.2", "1.16.4", "1.17.1", "1.18.2", "1.19.4", "1.20.4", "1.21.1"];
}

function main() {
  // İ4 güvenlik ağı: tek bir botun beklenmedik hatası tüm paneli düşürmemeli.
  // Hata yutulmaz — panel loguna ERROR olarak düşer.
  process.on("uncaughtException", (err) => {
    log.error("Yakalanmamış istisna (proses ayakta tutuldu)", String(err?.stack ?? err));
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Yakalanmamış promise reddi (proses ayakta tutuldu)", String(reason));
  });

  const supportedVersions = readSupportedVersions();

  const manager = new BotManager();
  manager.boot();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createRestRouter(manager, supportedVersions));
  app.use("/api", restErrorHandler);

  // üretimde derlenmiş paneli de bu port servis eder (dev'de vite 3000'de)
  if (fs.existsSync(path.join(WEB_DIST_DIR, "index.html"))) {
    app.use(express.static(WEB_DIST_DIR));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) return next();
      res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
    });
    log.info("Derlenmiş panel bulundu — statik olarak servis ediliyor");
  }

  const httpServer = http.createServer(app);
  const io = new SocketServer(httpServer);
  setupSocket(io, manager, supportedVersions);

  httpServer.listen(PORT, HOST, () => {
    log.success(`CaYa Bot Panel API hazır: http://${HOST}:${PORT} (mineflayer sürümleri: ${supportedVersions.length})`);
  });

  const shutdown = () => {
    log.info("Kapatılıyor — tüm botlar durduruluyor…");
    manager.shutdown();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();

import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { Server as SocketServer } from "socket.io";
import { createRestRouter, restErrorHandler } from "./api/rest";
import { setupSocket } from "./api/socket";
import { DATA_DIR, WEB_DIST_DIR } from "./config/paths";
import { BotManager } from "./core/BotManager";
import { AgentService } from "./modules/agent";
import { createMcpRouter } from "./modules/agent/mcpHttp";
import { migrateLoginSecrets } from "./modules/alwaysOn/secrets";
import { accounts } from "./modules/auth/accounts";
import { migrateDiscordSecrets } from "./modules/discord/store";
import { httpGuard, parseAllowedHosts, socketGuard, type GuardOptions } from "./security/httpGuard";
import { restrictToCurrentUser } from "./security/permissions";
import { initSecretBox } from "./security/secretBox";
import { createLogger } from "./utils/logger";

const PORT = Number(process.env.CAYA_PORT || 3001);
const HOST = process.env.CAYA_HOST || "127.0.0.1"; // security: default localhost only

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

async function main() {
  // İ4 safek ağı: tek bir botun beklenmedik hatası tüm paneli düşürmemeli.
  // Hata yutulmaz — panel loguna ERROR olarak düşer.
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception (process kept alive)", String(err?.stack ?? err));
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection (process kept alive)", String(reason));
  });

  // Secrets must be readable before any store loads, so wait for the data key first.
  await initSecretBox();
  restrictToCurrentUser(DATA_DIR);
  try {
    accounts.load();
    migrateDiscordSecrets();
    migrateLoginSecrets();
  } catch (err) {
    log.error("Secret migration failed", String(err));
  }

  const supportedVersions = readSupportedVersions();
  const guard: GuardOptions = { bindHost: HOST, allowedHosts: parseAllowedHosts(process.env.CAYA_ALLOWED_HOSTS) };

  const manager = new BotManager();
  manager.boot();

  // Faz 18 — MCP / AI agent sistemi (Ollama oyun içi ajan + /mcp endpoint)
  const agents = new AgentService(manager, { host: HOST, port: PORT });
  agents.boot();

  const app = express();
  // şema yükleme base64 for büyük body; diğer rotalar da aynı limit (localhost panel)
  app.disable("x-powered-by");
  app.use(["/api", "/mcp", "/socket.io"], httpGuard(guard));
  app.use(express.json({ limit: "32mb" }));
  app.use("/api", createRestRouter(manager, supportedVersions, agents));
  app.use("/api", restErrorHandler);
  // Model Context Protocol endpoint — Claude Code vb. dış istemciler for
  app.use("/mcp", createMcpRouter(manager, agents));

  // üretimde derlenmiş paneli de bu port servis eder (dev'de vite 3000'de)
  if (fs.existsSync(path.join(WEB_DIST_DIR, "index.html"))) {
    app.use(express.static(WEB_DIST_DIR));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/socket.io") || req.path.startsWith("/mcp")) return next();
      res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
    });
    log.info("Compiled panel found — serving statically");
  }

  const httpServer = http.createServer(app);
  const io = new SocketServer(httpServer, { allowRequest: socketGuard(guard) });
  setupSocket(io, manager, supportedVersions, agents);

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    // Without this the error is swallowed by the uncaughtException guard and
    // the process lingers without a listening socket.
    log.error(`Could not listen on ${HOST}:${PORT}`, err.code === "EADDRINUSE" ? "port already in use" : String(err));
    process.exit(1);
  });

  httpServer.listen(PORT, HOST, () => {
    log.success(`Minecraft CaYa Bot Panel API ready: http://${HOST}:${PORT} (mineflayer versions: ${supportedVersions.length})`);
  });

  const shutdown = () => {
    log.info("Shutting down — stopping all bots…");
    agents.shutdown();
    manager.shutdown();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Forked by the desktop app: exit with it instead of staying behind as an
  // orphan that keeps the port and the bots' sessions open.
  if (typeof process.send === "function") process.on("disconnect", shutdown);
}

void main();

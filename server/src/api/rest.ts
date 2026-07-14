import { Router, type NextFunction, type Request, type Response } from "express";
import { BotManager, PanelError } from "../core/BotManager";
import { logHub } from "../utils/logger";

type Handler = (req: Request, res: Response) => void | Promise<void>;

/** express 4 async hatalarını yakalamaz — tüm handler'lar bu sarmalayıcıdan geçer */
const h =
  (fn: Handler) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

export function createRestRouter(manager: BotManager, supportedVersions: string[]): Router {
  const r = Router();

  // ---- state ----------------------------------------------------------------
  r.get(
    "/state",
    h((_req, res) => {
      res.json(manager.snapshot(supportedVersions));
    })
  );

  // ---- servers ----------------------------------------------------------------
  r.post(
    "/servers",
    h((req, res) => {
      res.json(manager.createServer(req.body ?? {}));
    })
  );
  r.patch(
    "/servers/:id",
    h((req, res) => {
      res.json(manager.updateServer(req.params.id!, req.body ?? {}));
    })
  );
  r.delete(
    "/servers/:id",
    h((req, res) => {
      manager.deleteServer(req.params.id!);
      res.json({ ok: true });
    })
  );

  // ---- bots -------------------------------------------------------------------
  r.post(
    "/bots",
    h((req, res) => {
      const { username, serverId, autostart, startNow } = req.body ?? {};
      const inst = manager.createBot({ username, serverId, autostart });
      if (startNow) inst.start();
      res.json(inst.getSnapshot());
    })
  );

  r.post(
    "/bots/bulk",
    h((req, res) => {
      const { template, count, serverId, autostart, startNow } = req.body ?? {};
      const n = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)));
      const created = manager.bulkCreate(String(template || "CaYa_{n}"), n, String(serverId || ""), Boolean(autostart));
      if (startNow) manager.startStaggered(created.map((b) => b.config.id));
      res.json({ created: created.map((b) => b.getSnapshot()) });
    })
  );

  r.patch(
    "/bots/:id",
    h((req, res) => {
      res.json(manager.updateBotConfig(req.params.id!, req.body ?? {}).getSnapshot());
    })
  );

  r.delete(
    "/bots/:id",
    h((req, res) => {
      manager.removeBot(req.params.id!);
      res.json({ ok: true });
    })
  );

  r.post(
    "/bots/:id/start",
    h((req, res) => {
      manager.startBot(req.params.id!);
      res.json({ ok: true });
    })
  );

  r.post(
    "/bots/:id/stop",
    h((req, res) => {
      manager.stopBot(req.params.id!);
      res.json({ ok: true });
    })
  );

  r.post(
    "/bots/start-all",
    h((req, res) => {
      const count = manager.startStaggered(req.body?.ids);
      res.json({ ok: true, count });
    })
  );

  r.post(
    "/bots/stop-all",
    h((req, res) => {
      const count = manager.stopAll(req.body?.ids);
      res.json({ ok: true, count });
    })
  );

  r.post(
    "/bots/:id/chat",
    h((req, res) => {
      const text = String(req.body?.text ?? "").trim();
      if (!text) throw new PanelError("Boş mesaj gönderilemez.");
      manager.mustGet(req.params.id!).sendChat(text);
      res.json({ ok: true, queued: manager.mustGet(req.params.id!).chatQueueLength });
    })
  );

  r.get(
    "/bots/:id/chat-history",
    h((req, res) => {
      const inst = manager.mustGet(req.params.id!);
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
      res.json(inst.chatHistory.slice(-limit));
    })
  );

  // ---- logs ---------------------------------------------------------------------
  r.get(
    "/logs",
    h((req, res) => {
      const botId = req.query.botId ? String(req.query.botId) : undefined;
      const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 300));
      res.json(logHub.recent(botId, limit));
    })
  );

  return r;
}

/** PanelError → anlamlı HTTP durumu; diğerleri 500 */
export function restErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof PanelError) {
    res.status(err.httpStatus).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "Bilinmeyen sunucu hatası" });
}

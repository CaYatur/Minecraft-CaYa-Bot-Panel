import { Router, type NextFunction, type Request, type Response } from "express";
import { BotManager, PanelError } from "../core/BotManager";
import {
  ACTION_META,
  CONDITION_META,
  CONTEXT_VARS_ALL,
  CONTEXT_VARS_BY_TRIGGER,
  CONTEXT_VARS_COMMON,
  findBlueprint,
  RULE_TEMPLATES,
  TRIGGER_META
} from "../modules/automation/RuleEngine";
import {
  addCayaJsonSchematic,
  addSchematicFromBase64,
  deleteSchematic,
  getSchematicMeta,
  listSchematics,
  loadParsedSchematic
} from "../modules/build";
import { getCatalog } from "../modules/catalog/minecraftCatalog";
import type { AgentService } from "../modules/agent";
import { runInventoryOp } from "../modules/inventory";
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

export function createRestRouter(manager: BotManager, supportedVersions: string[], agents?: AgentService): Router {
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
      if (!text) throw new PanelError("Cannot send an empty message.");
      manager.mustGet(req.params.id!).sendChat(text);
      res.json({ ok: true, queued: manager.mustGet(req.params.id!).chatQueueLength });
    })
  );

  // ---- actions & tasks (Faz 4) --------------------------------------------------
  r.post(
    "/bots/:id/action",
    h((req, res) => {
      const inst = manager.mustGet(req.params.id!);
      let action: Record<string, unknown> = req.body ?? {};

      // waypoint targeti burada çözülür (görev etiketi waypoint adını taşır)
      if (action.type === "goto-waypoint") {
        const wp = manager.waypoints.get(String(action.waypointId ?? ""));
        if (wp.serverId !== inst.config.serverId) throw new PanelError("This waypoint belongs to a different server profile.");
        if (inst.status === "online" && inst.runtime.dimension !== wp.dimension) {
          throw new PanelError(`Waypoint is in ${wp.dimension}, bot is in ${inst.runtime.dimension} — change dimension first.`);
        }
        action = { type: "goto", x: wp.x, y: wp.y, z: wp.z, range: action.range ?? 2, label: `goto waypoint: ${wp.name}` };
      }

      try {
        const actionType = String(action.type ?? "");
        if (["reset-work", "reset-all", "işleri-sıfırla", "soft-reset"].includes(actionType)) {
          manager.cancelAllWork(req.params.id!, String(action.reason ?? "all work reset from panel"));
          res.json({ ok: true, task: null });
          return;
        }
        const task = inst.enqueueAction(action);
        res.json({ ok: true, task });
      } catch (err) {
        throw new PanelError(err instanceof Error ? err.message : String(err));
      }
    })
  );

  r.post(
    "/bots/:id/tasks/:taskId/cancel",
    h((req, res) => {
      const inst = manager.mustGet(req.params.id!);
      if (!inst.tasks.cancel(req.params.taskId!, "cancelled from panel")) {
        throw new PanelError("Task not found (it may have finished).", 404);
      }
      res.json({ ok: true });
    })
  );

  r.post(
    "/bots/:id/tasks/cancel-all",
    h((req, res) => {
      manager.cancelAllWork(req.params.id!, "all cancelled from panel");
      res.json({ ok: true });
    })
  );

  // ---- inventory (Faz 5) -----------------------------------------------------------
  r.post(
    "/bots/:id/inventory",
    h(async (req, res) => {
      const inst = manager.mustGet(req.params.id!);
      try {
        await runInventoryOp(inst, req.body ?? {});
      } catch (err) {
        if (err instanceof PanelError) throw err;
        // mineflayer'ın ham hataları (equip timeout vb.) panele anlaşılır dönsün
        throw new PanelError(`Inventory action failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      res.json({ ok: true });
    })
  );

  // ---- waypoints (Faz 4) ---------------------------------------------------------
  r.get(
    "/waypoints",
    h((req, res) => {
      const serverId = String(req.query.serverId ?? "");
      if (!serverId) throw new PanelError("serverId query parameter is required.");
      res.json(manager.waypoints.forServer(serverId));
    })
  );

  r.post(
    "/waypoints",
    h((req, res) => {
      const { serverId, name, x, y, z, dimension, note } = req.body ?? {};
      res.json(manager.createWaypoint(String(serverId ?? ""), { name, x, y, z, dimension, note }));
    })
  );

  r.delete(
    "/waypoints/:id",
    h((req, res) => {
      manager.deleteWaypoint(req.params.id!);
      res.json({ ok: true });
    })
  );

  r.post(
    "/bots/:id/waypoint-here",
    h((req, res) => {
      const inst = manager.mustGet(req.params.id!);
      if (inst.status !== "online") throw new PanelError("Bot offline — cannot read current position.");
      const wp = manager.createWaypoint(inst.config.serverId, {
        name: String(req.body?.name ?? ""),
        x: inst.runtime.position.x,
        y: inst.runtime.position.y,
        z: inst.runtime.position.z,
        dimension: inst.runtime.dimension,
        note: req.body?.note
      });
      res.json(wp);
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

  // ---- tasks pause/resume (Faz 10) -----------------------------------------------
  r.post(
    "/bots/:id/tasks/pause",
    h((req, res) => {
      const ok = manager.mustGet(req.params.id!).tasks.pause("paused from panel");
      res.json({ ok });
    })
  );
  r.post(
    "/bots/:id/tasks/resume",
    h((req, res) => {
      const ok = manager.mustGet(req.params.id!).tasks.resume();
      res.json({ ok });
    })
  );
  r.get(
    "/bots/:id/tasks/history",
    h((req, res) => {
      res.json(manager.mustGet(req.params.id!).tasks.historySummaries);
    })
  );

  // ---- craft plan (Faz 9) --------------------------------------------------------
  r.get(
    "/bots/:id/craft-plan",
    h((req, res) => {
      const item = String(req.query.item ?? "");
      const count = Math.max(1, Number(req.query.count) || 1);
      if (!item) throw new PanelError("item query parameter is required");
      res.json({ plan: manager.mustGet(req.params.id!).craft.previewPlan(item, count) });
    })
  );

  // ---- rules (Faz 11) ------------------------------------------------------------
  r.get(
    "/rules",
    h((_req, res) => {
      res.json(manager.rules.list());
    })
  );
  r.post(
    "/rules",
    h((req, res) => {
      res.json(manager.rules.create(req.body ?? {}));
    })
  );
  r.patch(
    "/rules/:id",
    h((req, res) => {
      try {
        res.json(manager.rules.update(req.params.id!, req.body ?? {}));
      } catch (e) {
        throw new PanelError(e instanceof Error ? e.message : String(e), 404);
      }
    })
  );
  r.delete(
    "/rules/:id",
    h((req, res) => {
      manager.rules.remove(req.params.id!);
      res.json({ ok: true });
    })
  );
  r.post(
    "/rules/:id/test",
    h(async (req, res) => {
      const botId = String(req.body?.botId ?? "");
      if (!botId) throw new PanelError("botId is required");
      await manager.rules.testRule(req.params.id!, botId);
      res.json({ ok: true });
    })
  );
  r.post(
    "/rules/templates/:name",
    h((req, res) => {
      const name = decodeURIComponent(String(req.params.name ?? ""));
      const bp = findBlueprint(name);
      const tpl = bp?.rule ?? RULE_TEMPLATES.find((t) => t.name === name);
      if (!tpl) throw new PanelError("Template/blueprint not found", 404);
      res.json(
        manager.rules.create({
          ...tpl,
          name: bp?.name ?? tpl.name,
          botIds: req.body?.botIds ?? "all"
        })
      );
    })
  );

  // ---- world memory (Faz 10) -----------------------------------------------------
  r.get(
    "/world-memory",
    h((req, res) => {
      const serverId = String(req.query.serverId ?? "");
      if (!serverId) throw new PanelError("serverId is required");
      res.json({
        chests: manager.worldMemory.chestsFor(serverId),
        ores: manager.worldMemory.oresFor(serverId)
      });
    })
  );

  // ---- catalog (Faz 13) — sürüme göre item/ore listesi ---------------------------
  r.get(
    "/catalog",
    h((req, res) => {
      const version = String(req.query.version ?? "auto");
      const cat = getCatalog(version);
      res.json(cat);
    })
  );

  r.get(
    "/rules/meta",
    h((_req, res) => {
      res.json({
        triggers: TRIGGER_META,
        actions: ACTION_META,
        conditions: CONDITION_META,
        // stok blueprint/şablon yok — kullanıcı kural oluşturur ve düzenler
        templates: [] as string[],
        blueprints: [] as Array<{ id: string; name: string; category: string; description: string }>,
        vars: CONTEXT_VARS_ALL,
        varsByTrigger: CONTEXT_VARS_BY_TRIGGER,
        varsCommon: CONTEXT_VARS_COMMON,
        flow: {
          version: 2,
          nodeTypes: ["action", "if", "set", "wait", "repeat", "stop_flow"],
          conditionGroups: ["all", "any", "not"],
          compareOperators: [
            "eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "regex",
            "gt", "gte", "lt", "lte", "exists", "not_exists", "truthy", "falsy"
          ],
          taskResultFields: [
            "status", "taskId", "taskType", "label", "error", "progressDone", "progressTotal"
          ]
        }
      });
    })
  );

  // ---- nearby players (Faz 13) ---------------------------------------------------
  r.get(
    "/bots/:id/nearby",
    h((req, res) => {
      const inst = manager.mustGet(req.params.id!);
      const maxDist = Math.max(4, Math.min(128, Number(req.query.radius) || 48));
      res.json({ players: inst.getNearbyPlayers(maxDist) });
    })
  );

  // ---- schematics / yapı (Faz 14) ------------------------------------------------
  r.get(
    "/schematics",
    h((_req, res) => {
      res.json({ items: listSchematics() });
    })
  );

  r.get(
    "/schematics/:id",
    h(async (req, res) => {
      const meta = getSchematicMeta(req.params.id!);
      if (!meta) throw new PanelError("Schematic not found", 404);
      const version = String(req.query.version ?? "1.20.4");
      const parsed = await loadParsedSchematic(meta.id, version);
      res.json({
        meta: parsed.meta,
        blockCount: parsed.blocks.length,
        size: { w: parsed.width, h: parsed.height, l: parsed.length },
        materials: Object.entries(
          parsed.blocks.reduce<Record<string, number>>((acc, b) => {
            acc[b.name] = (acc[b.name] ?? 0) + 1;
            return acc;
          }, {})
        )
          .map(([name, need]) => ({ name, need }))
          .sort((a, b) => b.need - a.need)
      });
    })
  );

  r.post(
    "/schematics",
    h(async (req, res) => {
      const body = req.body ?? {};
      if (Array.isArray(body.blocks)) {
        if (body.blocks.length > 150_000) throw new PanelError("Maximum 150000 blocks");
        res.json(addCayaJsonSchematic({ name: String(body.name || "Schematic"), blocks: body.blocks, note: body.note }));
        return;
      }
      if (!body.dataBase64) throw new PanelError("dataBase64 or blocks required");
      // base64 boyutu kaba kontrol (≈ 25MB binary)
      if (String(body.dataBase64).length > 36 * 1024 * 1024) throw new PanelError("File too large (max ~25MB)");
      res.json(
        await addSchematicFromBase64({
          name: String(body.name || "Schematic"),
          filename: body.filename ? String(body.filename) : undefined,
          dataBase64: String(body.dataBase64),
          note: body.note ? String(body.note) : undefined
        })
      );
    })
  );

  r.delete(
    "/schematics/:id",
    h((req, res) => {
      try {
        if (!deleteSchematic(req.params.id!)) throw new PanelError("Schematic not found", 404);
        res.json({ ok: true });
      } catch (e) {
        if (e instanceof PanelError) throw e;
        throw new PanelError(e instanceof Error ? e.message : String(e));
      }
    })
  );

  r.get(
    "/bots/:id/build",
    h((req, res) => {
      res.json(manager.mustGet(req.params.id!).build.getRuntime());
    })
  );

  // ---- MCP / AI agent (Faz 18) -----------------------------------------------------
  if (agents) {
    r.get(
      "/mcp",
      h((_req, res) => {
        res.json(agents.getStatus());
      })
    );

    r.patch(
      "/mcp/settings",
      h((req, res) => {
        agents.updateSettings(req.body ?? {});
        res.json(agents.getStatus());
      })
    );

    r.post(
      "/mcp/token/regenerate",
      h((_req, res) => {
        res.json({ token: agents.regenerateToken() });
      })
    );

    r.get(
      "/mcp/ollama/models",
      h(async (req, res) => {
        try {
          const models = await agents.listModels(req.query.host ? String(req.query.host) : undefined);
          res.json({ models });
        } catch (err) {
          throw new PanelError(err instanceof Error ? err.message : String(err), 502);
        }
      })
    );

    r.post(
      "/mcp/ollama/test",
      h(async (req, res) => {
        try {
          res.json(await agents.testOllama(req.body?.host ? String(req.body.host) : undefined));
        } catch (err) {
          throw new PanelError(err instanceof Error ? err.message : String(err), 502);
        }
      })
    );

    r.patch(
      "/mcp/bots/:id",
      h((req, res) => {
        res.json(agents.setBotAgent(req.params.id!, req.body ?? {}));
      })
    );

    r.post(
      "/mcp/agent/:id/message",
      h(async (req, res) => {
        const text = String(req.body?.text ?? "").trim();
        if (!text) throw new PanelError("Message cannot be empty.");
        const reply = await agents.panelMessage(req.params.id!, text.slice(0, 4000));
        res.json({ reply });
      })
    );

    r.get(
      "/mcp/agent/:id/history",
      h((req, res) => {
        res.json({ messages: agents.getTranscript(req.params.id!) });
      })
    );

    r.post(
      "/mcp/agent/:id/reset",
      h((req, res) => {
        agents.resetConversation(req.params.id!);
        res.json({ ok: true });
      })
    );

    r.post(
      "/mcp/agent/:id/stop",
      h((req, res) => {
        agents.stopRun(req.params.id!);
        res.json({ ok: true });
      })
    );
  }

  r.get(
    "/bots/:id/build/preview",
    h(async (req, res) => {
      const inst = manager.mustGet(req.params.id!);
      const schematicId = String(req.query.schematicId ?? "");
      if (!schematicId) throw new PanelError("schematicId is required");
      const version = String(req.query.version ?? "1.20.4");
      const rotateY = req.query.rotateY != null ? Number(req.query.rotateY) : 0;
      const mirrorX = req.query.mirrorX === "1" || req.query.mirrorX === "true";
      const mirrorZ = req.query.mirrorZ === "1" || req.query.mirrorZ === "true";
      res.json(
        await inst.build.previewMaterials(schematicId, version, {
          rotateY: (rotateY as 0 | 90 | 180 | 270) || 0,
          mirrorX,
          mirrorZ
        })
      );
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
  res.status(500).json({ error: err instanceof Error ? err.message : "Unknown server error" });
}

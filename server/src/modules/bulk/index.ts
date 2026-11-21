import type { BotInstance } from "../../core/BotInstance";
import type { BotManager } from "../../core/BotManager";
import { PanelError } from "../../core/errors";
import { runGuiOp } from "../window";

/**
 * Issue #34 — panelde seçilen botlara tek seferde işlem gönderme.
 * Her bot ayrı denenir; birinin hatası diğerlerini durdurmaz ve sonuç bot bazında döner.
 */

export const BULK_ACTIONS = [
  "start",
  "stop",
  "chat",
  "use-item",
  "hotbar",
  "click-slot",
  "close-window",
  "stop-work",
  "task"
] as const;
export type BulkActionType = (typeof BULK_ACTIONS)[number];

/** MCP izin kategorisi — bulk_action her işlemi kendi kategorisine göre denetler */
export const BULK_ACTION_CATEGORY: Record<BulkActionType, "info" | "chat" | "inventory" | null> = {
  start: "info",
  stop: "info",
  chat: "chat",
  "use-item": "inventory",
  hotbar: "inventory",
  "click-slot": "inventory",
  "close-window": "inventory",
  "stop-work": "info",
  // görev kuyruğuna ham aksiyon — yalnızca panel/REST; MCP'de kapalı
  task: null
};

export const BULK_MAX_BOTS = 100;

export interface BulkActionInput {
  type?: unknown;
  /** chat: metin; {bot} botun kullanıcı adıyla değişir */
  text?: unknown;
  hotbar?: unknown;
  item?: unknown;
  slot?: unknown;
  button?: unknown;
  offhand?: unknown;
  holdMs?: unknown;
  waitWindowMs?: unknown;
  waitMs?: unknown;
  /** task: BotInstance.enqueueAction'a giden aksiyon nesnesi */
  action?: unknown;
  /** botlar arası gecikme (ms), sunucuya aynı anda paket yağmasın */
  staggerMs?: unknown;
}

export interface BulkBotResult {
  botId: string;
  username: string;
  ok: boolean;
  message: string;
}

export interface BulkResult {
  action: BulkActionType;
  okCount: number;
  failCount: number;
  results: BulkBotResult[];
}

export function bulkActionType(value: unknown): BulkActionType {
  const type = String(value ?? "").trim().toLowerCase() as BulkActionType;
  if (!BULK_ACTIONS.includes(type)) throw new PanelError(`Unknown bulk action "${String(value ?? "")}" (${BULK_ACTIONS.join(", ")}).`);
  return type;
}

export function normalizeBulkIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const ids = [...new Set(list.map((v) => String(v ?? "").trim()).filter(Boolean))];
  if (!ids.length) throw new PanelError("Select at least one bot.");
  if (ids.length > BULK_MAX_BOTS) throw new PanelError(`At most ${BULK_MAX_BOTS} bots per bulk action.`);
  return ids;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultStagger(type: BulkActionType): number {
  // sohbet ve menü tıklamaları biraz aralıklı; başlat zaten kendi aralığını kullanır
  return type === "chat" || type === "use-item" || type === "click-slot" ? 200 : 0;
}

async function runOne(manager: BotManager, inst: BotInstance, type: BulkActionType, input: BulkActionInput): Promise<string> {
  const id = inst.config.id;
  switch (type) {
    case "start":
      return inst.status === "online" ? "already online" : "starting";
    case "stop":
      manager.stopBot(id);
      return "stopped";
    case "stop-work":
      manager.cancelAllWork(id, "bulk stop-work from panel");
      return "all work stopped";
    case "chat": {
      if (inst.status !== "online") throw new PanelError("bot is not online");
      const text = String(input.text ?? "").replace(/\{bot\}/g, inst.config.username).trim();
      if (!text) throw new PanelError("Cannot send an empty message.");
      inst.sendChat(text.slice(0, 256));
      return `queued: ${text.slice(0, 80)}`;
    }
    case "use-item": {
      const res = await runGuiOp(inst, { op: "use", hotbar: input.hotbar, item: input.item, offhand: input.offhand, holdMs: input.holdMs, waitWindowMs: input.waitWindowMs });
      if (res.op !== "use") return "used";
      const r = res.result;
      return `used ${r.used ?? "empty hand"}${r.openedWindow ? ` → window "${r.window.title}" opened` : ""}`;
    }
    case "hotbar": {
      const res = await runGuiOp(inst, { op: "hotbar", hotbar: input.hotbar });
      return res.op === "hotbar" ? `hotbar ${res.hotbar} (${res.held ?? "empty"})` : "hotbar set";
    }
    case "click-slot": {
      const res = await runGuiOp(inst, { op: "click", slot: input.slot, button: input.button, hotbar: input.hotbar, waitMs: input.waitMs });
      if (res.op !== "click") return "clicked";
      const r = res.result;
      return `clicked slot ${r.clicked.slot} (${r.clicked.item ?? "empty"}) → ${r.changed}${r.window.open ? ` "${r.window.title}"` : ""}`;
    }
    case "close-window": {
      const res = await runGuiOp(inst, { op: "close" });
      return res.op === "close" && res.closed ? "window closed" : "no window was open";
    }
    case "task": {
      const action = input.action && typeof input.action === "object" ? (input.action as Record<string, unknown>) : null;
      if (!action || !action.type) throw new PanelError("task needs an action object with a type.");
      const task = inst.enqueueAction({ ...action });
      return task ? `task queued: ${task.label}` : "done";
    }
  }
}

export async function runBulkAction(manager: BotManager, rawIds: unknown, input: BulkActionInput): Promise<BulkResult> {
  const type = bulkActionType(input.type);
  const ids = normalizeBulkIds(rawIds);
  const stagger = Math.max(0, Math.min(5_000, Math.floor(Number(input.staggerMs ?? defaultStagger(type)) || 0)));
  const found: BotInstance[] = [];
  const results = new Map<string, BulkBotResult>();
  for (const id of ids) {
    const inst = manager.get(id);
    if (!inst) results.set(id, { botId: id, username: "?", ok: false, message: "bot not found" });
    else found.push(inst);
  }
  if (type === "start") {
    // mevcut kademeli başlatma (BULK_START_STAGGER_MS + autostart gecikmesi) korunur
    manager.startStaggered(found.filter((b) => b.status !== "online").map((b) => b.config.id));
  }
  await Promise.all(
    found.map(async (inst, i) => {
      if (stagger && i) await sleep(stagger * i);
      try {
        const message = await runOne(manager, inst, type, input);
        results.set(inst.config.id, { botId: inst.config.id, username: inst.config.username, ok: true, message });
      } catch (err) {
        results.set(inst.config.id, { botId: inst.config.id, username: inst.config.username, ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    })
  );
  const ordered = ids.map((id) => results.get(id)).filter((r): r is BulkBotResult => Boolean(r));
  return {
    action: type,
    okCount: ordered.filter((r) => r.ok).length,
    failCount: ordered.filter((r) => !r.ok).length,
    results: ordered
  };
}

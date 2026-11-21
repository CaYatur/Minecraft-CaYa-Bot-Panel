import { useEffect, useState } from "react";
import { MousePointerClick, X } from "lucide-react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { EV } from "../lib/events";
import { socket } from "../lib/socket";
import type { WindowItem, WindowSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

type ClickButton = "left" | "right" | "shift";

/**
 * Issue #34 — eldeki eşyayı kullan (sağ tık) ve açılan sunucu menüsünü
 * (sunucu seçici, mağaza, sandık) görüp slotlarına tıkla.
 */
export function WindowPanel({ botId }: { botId: string }) {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const online = useAppStore((s) => s.bots[botId]?.status === "online");
  const heldQuickBar = useAppStore((s) => s.bots[botId]?.inventory?.heldQuickBar ?? 0);
  const [win, setWin] = useState<WindowSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [button, setButton] = useState<ClickButton>("left");
  const [showInventory, setShowInventory] = useState(false);

  useEffect(() => {
    if (!online) {
      setWin(null);
      return;
    }
    let alive = true;
    void api
      .get<WindowSnapshot>(`/api/bots/${botId}/window`)
      .then((row) => alive && setWin(row))
      .catch(() => undefined);
    const onWindow = (p: { botId: string; window: WindowSnapshot }) => {
      if (p.botId === botId) setWin(p.window);
    };
    socket.on(EV.BOT_WINDOW, onWindow);
    return () => {
      alive = false;
      socket.off(EV.BOT_WINDOW, onWindow);
    };
  }, [botId, online]);

  const gui = async (body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ op: string; result?: { window?: WindowSnapshot; openedWindow?: boolean; changed?: string }; window?: WindowSnapshot }>(
        `/api/bots/${botId}/gui`,
        body
      );
      const next = res.result?.window ?? res.window;
      if (next) setWin(next);
      if (res.op === "use" && res.result && !res.result.openedWindow && !next?.open) toast("info", t("gui.noWindowOpened"));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = Boolean(win?.open);
  const menu = open ? win!.slots.slice(0, win!.containerSlots) : [];
  const lower = open ? win!.slots.slice(win!.containerSlots) : [];

  const Slot = ({ it, slot }: { it: WindowItem | null; slot: number }) => (
    <button
      type="button"
      disabled={!online || busy}
      onClick={() => void gui({ op: "click", slot, button, windowId: win?.id })}
      title={
        it
          ? [it.customName || it.displayName, `${it.name} ×${it.count}`, ...it.lore, t("gui.slotHint", { slot })].join("\n")
          : t("gui.slotHint", { slot })
      }
      className={`relative flex h-14 w-14 flex-col items-center justify-center rounded-lg border text-center transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        it ? "border-zinc-700 bg-zinc-800/80 hover:border-indigo-400 hover:bg-zinc-700/80" : "border-dashed border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
      }`}
    >
      {it && (
        <>
          <span className="line-clamp-2 px-0.5 text-[9px] leading-tight text-zinc-100">{it.customName || it.displayName}</span>
          {it.customName && it.customName !== it.displayName && (
            <span className="line-clamp-1 px-0.5 text-[8px] leading-tight text-zinc-500">{it.displayName}</span>
          )}
          {it.count > 1 && (
            <span className="mono absolute right-0.5 bottom-0.5 rounded bg-zinc-950/80 px-1 text-[9px] font-bold text-zinc-100">{it.count}</span>
          )}
        </>
      )}
      <span className="mono absolute top-0.5 left-1 text-[8px] text-zinc-600">{slot}</span>
    </button>
  );

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">{t("gui.title")}</span>
        <button
          type="button"
          disabled={!online || busy}
          onClick={() => void gui({ op: "use" })}
          title={t("gui.useHint")}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MousePointerClick className="h-3.5 w-3.5" /> {t("gui.useHeld", { slot: heldQuickBar + 1 })}
        </button>
        {open && (
          <>
            <label className="ml-2 flex items-center gap-1 text-xs text-zinc-400">
              {t("gui.clickType")}
              <select
                value={button}
                onChange={(e) => setButton(e.target.value as ClickButton)}
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200"
              >
                <option value="left">{t("gui.left")}</option>
                <option value="right">{t("gui.right")}</option>
                <option value="shift">{t("gui.shift")}</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs text-zinc-400">
              <input type="checkbox" checked={showInventory} onChange={(e) => setShowInventory(e.target.checked)} />
              {t("gui.showInventory")}
            </label>
            <button
              type="button"
              disabled={!online || busy}
              onClick={() => void gui({ op: "close" })}
              className="ml-auto flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> {t("gui.close")}
            </button>
          </>
        )}
      </div>
      {!online ? (
        <p className="text-xs text-zinc-600 italic">{t("gui.offline")}</p>
      ) : !open ? (
        <p className="text-xs text-zinc-600 italic">{t("gui.none")}</p>
      ) : (
        <div className="flex flex-col gap-2" aria-busy={busy}>
          <div className="text-sm text-zinc-200">
            <b>{win!.title}</b> <span className="mono text-[10px] text-zinc-500">({win!.type} · id {win!.id})</span>
          </div>
          <div className="grid w-max grid-cols-9 gap-1.5">
            {menu.map((it, i) => (
              <Slot key={i} it={it} slot={i} />
            ))}
          </div>
          {showInventory && lower.length > 0 && (
            <div className="grid w-max grid-cols-9 gap-1.5 border-t border-zinc-800 pt-2">
              {lower.map((it, i) => (
                <Slot key={i} it={it} slot={win!.containerSlots + i} />
              ))}
            </div>
          )}
          <p className="text-[11px] text-zinc-500">{t("gui.clickHelp")}</p>
        </div>
      )}
    </div>
  );
}

import type { ReactNode } from "react";
/** Issue #34 — menü / eldeki eşya otomasyon aksiyonlarının alanları (basit ve gelişmiş editör ortak). */
export const GUI_ACTION_TYPES = ["use_held_item", "select_hotbar_slot", "click_window_slot", "close_window"] as const;

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface Props {
  action: Record<string, unknown>;
  patch: (patch: Record<string, unknown>) => void;
  t: Translate;
  fieldCls: string;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export function GuiActionFields({ action, patch, t, fieldCls }: Props) {
  const type = String(action.type ?? "");
  if (!(GUI_ACTION_TYPES as readonly string[]).includes(type) || type === "close_window") return null;
  const label = (text: string, child: ReactNode) => (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="text-zinc-500">{text}</span>
      {child}
    </label>
  );
  if (type === "select_hotbar_slot") {
    return label(
      t("automations.gui.hotbar"),
      <input type="number" min={0} max={8} value={str(action.slot ?? 0)} onChange={(e) => patch({ slot: e.target.value })} className={`${fieldCls} w-20`} />
    );
  }
  const wait = label(
    t("automations.gui.waitSeconds"),
    <input
      type="number"
      min={0}
      max={15}
      step={0.5}
      value={str(action.waitSeconds ?? (type === "use_held_item" ? 2 : 3))}
      onChange={(e) => patch({ waitSeconds: e.target.value })}
      className={`${fieldCls} w-20`}
    />
  );
  if (type === "use_held_item") {
    return (
      <>
        {label(
          t("automations.gui.holdItem"),
          <input value={str(action.item)} onChange={(e) => patch({ item: e.target.value })} placeholder={t("automations.gui.phHoldItem")} className={`${fieldCls} w-40`} />
        )}
        {label(
          t("automations.gui.hotbarOptional"),
          <input type="number" min={0} max={8} value={str(action.hotbar)} onChange={(e) => patch({ hotbar: e.target.value })} className={`${fieldCls} w-20`} />
        )}
        {wait}
      </>
    );
  }
  // click_window_slot
  return (
    <>
      {label(
        t("automations.gui.menuItem"),
        <input value={str(action.item)} onChange={(e) => patch({ item: e.target.value })} placeholder={t("automations.gui.phMenuItem")} className={`${fieldCls} w-40`} />
      )}
      {label(
        t("automations.gui.slotOptional"),
        <input type="number" min={0} value={str(action.slot)} onChange={(e) => patch({ slot: e.target.value })} className={`${fieldCls} w-20`} />
      )}
      {label(
        t("automations.gui.button"),
        <select value={str(action.button || "left")} onChange={(e) => patch({ button: e.target.value })} className={`${fieldCls} w-28`}>
          <option value="left">{t("gui.left")}</option>
          <option value="right">{t("gui.right")}</option>
          <option value="shift">{t("gui.shift")}</option>
        </select>
      )}
      {wait}
    </>
  );
}

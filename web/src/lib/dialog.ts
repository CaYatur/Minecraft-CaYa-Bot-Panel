import { useEffect, useRef, type RefObject } from "react";

/** Open dialogs, topmost last. Only the topmost one reacts to Escape and Tab. */
const stack: Array<{ id: number }> = [];
let seq = 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("inert"));
}

/** Pure helper (tested): the next element for Tab / Shift+Tab inside a trap. */
export function nextTrapIndex(count: number, current: number, back: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return back ? count - 1 : 0;
  return back ? (current - 1 + count) % count : (current + 1) % count;
}

/** Pure helper (tested): only the topmost dialog handles keys. */
export function isTopmost(ids: number[], id: number): boolean {
  return ids.length > 0 && ids[ids.length - 1] === id;
}

/**
 * Shared dialog behavior: focus the first field (or `[data-autofocus]`) on
 * open, Escape closes the topmost dialog from anywhere on the page, Tab stays
 * inside the dialog, and focus returns to the opener on close.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void, open = true): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const entry = { id: ++seq };
    stack.push(entry);
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (root) {
      const first =
        root.querySelector<HTMLElement>("[data-autofocus]") ??
        root.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])') ??
        focusableIn(root)[0] ??
        root;
      if (first === root && !root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      first.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (!isTopmost(stack.map((row) => row.id), entry.id)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = focusableIn(ref.current);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = nextTrapIndex(items.length, index, e.shiftKey);
      e.preventDefault();
      items[next]?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);
}

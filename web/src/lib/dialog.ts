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

/** Minimal shape needed to decide where focus can go back to (tested). */
export interface ReturnCandidate {
  isConnected: boolean;
  disabled?: boolean;
  hasAttribute?: (name: string) => boolean;
}

/** Pure helper (tested): the first candidate still in the page and not disabled. */
export function pickReturnTarget<T extends ReturnCandidate>(candidates: Array<T | null | undefined>): T | null {
  for (const el of candidates) {
    if (!el || !el.isConnected || el.disabled) continue;
    if (el.hasAttribute?.("disabled") || el.hasAttribute?.("inert")) continue;
    return el;
  }
  return null;
}

/** Nearest enabled focusable element around `el` (its closest section/form, then the page). */
function nearestFocusable(el: HTMLElement | null): HTMLElement | null {
  let scope: HTMLElement | null = el?.parentElement ?? null;
  while (scope) {
    const found = focusableIn(scope).find((item) => item !== el);
    if (found) return found;
    scope = scope.parentElement;
  }
  return null;
}

export interface DialogOptions {
  /** Where focus goes on close when the opener is disabled or gone. */
  returnFallback?: () => HTMLElement | null;
}

/**
 * Shared dialog behavior: focus the first field (or `[data-autofocus]`) on
 * open, Escape closes the topmost dialog from anywhere on the page, Tab stays
 * inside the dialog, and focus returns to the opener on close. If the opener
 * is disabled or gone by then, focus goes to `returnFallback`, else to the
 * nearest focusable element, so it never drops to the page body.
 */
export function useDialog(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  open = true,
  options: DialogOptions = {}
): void {
  const fallbackRef = useRef(options.returnFallback);
  fallbackRef.current = options.returnFallback;
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
      const opened = opener && opener !== document.body ? opener : null;
      // Run after React commits the close so disabled states are current.
      queueMicrotask(() => {
        const target = pickReturnTarget<HTMLElement>([
          opened as (HTMLElement & { disabled?: boolean }) | null,
          fallbackRef.current?.() ?? null,
          nearestFocusable(opened)
        ]);
        target?.focus();
      });
    };
  }, [open]);
}

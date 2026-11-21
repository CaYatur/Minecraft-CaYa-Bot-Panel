import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { PanelError } from "../../core/errors";
import { chatComponentToText, stripLegacyCodes } from "../../utils/chatText";

/**
 * Issue #34 — sunucu menüleri (GUI) ve eldeki eşyayı kullanma.
 * Lobi sunucularında pusula / saat gibi bir eşyaya sağ tıklanınca sandık
 * görünümlü bir "sunucu seçici" penceresi açılır; oyuncu oradaki bir eşyaya
 * tıklayarak oyun moduna geçer. Bu modül aynı adımları panel, REST, socket ve
 * MCP için tek yerde toplar. Hareket gerektirmez.
 */

export type ClickButton = "left" | "right" | "shift" | "shift-right" | "middle" | "drop" | "drop-stack" | "number";

export interface WindowItem {
  slot: number;
  name: string;
  displayName: string;
  /** Sunucunun verdiği özel ad (renk kodları temizlenmiş), yoksa null */
  customName: string | null;
  lore: string[];
  count: number;
  /** "container" = menünün kendi slotu, "inventory"/"hotbar" = oyuncunun alt kısmı */
  section: "container" | "inventory" | "hotbar";
}

export interface WindowSnapshot {
  open: boolean;
  id: number | null;
  type: string | null;
  title: string;
  /** menünün kendi slot sayısı (alt kısımdaki oyuncu envanteri hariç) */
  containerSlots: number;
  /** pencerenin tüm slot sayısı */
  totalSlots: number;
  slots: (WindowItem | null)[];
  heldQuickBar: number;
  heldItem: string | null;
  ts: number;
}

interface WindowLike {
  id: number;
  type: string | number;
  title?: unknown;
  slots: (Item | null)[];
  inventoryStart: number;
  inventoryEnd: number;
  hotbarStart?: number;
}

function plain(value: unknown): string {
  if (value == null) return "";
  return stripLegacyCodes(chatComponentToText(value)).replace(/\s+/g, " ").trim();
}

function loreLines(item: Item): string[] {
  try {
    const raw = (item as unknown as { customLore?: unknown }).customLore;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map(plain).filter(Boolean).slice(0, 12);
  } catch {
    return [];
  }
}

function serializeWindowItem(item: Item, slot: number, win: WindowLike): WindowItem {
  let customName: string | null = null;
  try {
    const raw = (item as unknown as { customName?: unknown }).customName;
    customName = raw ? plain(raw) || null : null;
  } catch {
    customName = null;
  }
  const hotbarStart = win.hotbarStart ?? win.inventoryEnd - 9;
  const section = slot < win.inventoryStart ? "container" : slot >= hotbarStart ? "hotbar" : "inventory";
  return {
    slot,
    name: item.name,
    displayName: item.displayName,
    customName,
    lore: loreLines(item),
    count: item.count,
    section
  };
}

export function currentWindow(bot: Bot): WindowLike | null {
  const win = (bot as unknown as { currentWindow?: WindowLike | null }).currentWindow;
  return win ?? null;
}

export function snapshotWindow(bot: Bot | null | undefined): WindowSnapshot {
  const empty: WindowSnapshot = {
    open: false,
    id: null,
    type: null,
    title: "",
    containerSlots: 0,
    totalSlots: 0,
    slots: [],
    heldQuickBar: bot?.quickBarSlot ?? 0,
    heldItem: bot?.heldItem?.name ?? null,
    ts: Date.now()
  };
  if (!bot) return empty;
  const win = currentWindow(bot);
  if (!win) return empty;
  const total = Math.max(win.inventoryEnd ?? win.slots.length, win.slots.length);
  const slots: (WindowItem | null)[] = [];
  for (let i = 0; i < total; i++) {
    const it = win.slots[i];
    slots.push(it ? serializeWindowItem(it, i, win) : null);
  }
  return {
    open: true,
    id: win.id,
    type: String(win.type ?? ""),
    title: plain(win.title) || String(win.type ?? "window"),
    containerSlots: win.inventoryStart,
    totalSlots: total,
    slots,
    heldQuickBar: bot.quickBarSlot ?? 0,
    heldItem: bot.heldItem?.name ?? null,
    ts: Date.now()
  };
}

/** AI ajanları ve log için kısa metin özeti */
export function describeWindow(snap: WindowSnapshot, includeInventory = false): string {
  if (!snap.open) return `No window is open. Held hotbar slot ${snap.heldQuickBar} (${snap.heldItem ?? "empty hand"}).`;
  const lines = [`Open window "${snap.title}" (type ${snap.type}, id ${snap.id}, ${snap.containerSlots} menu slots, slots 0-${snap.containerSlots - 1}).`];
  const rows = snap.slots.filter((s): s is WindowItem => Boolean(s) && (includeInventory || s!.section === "container"));
  if (!rows.length) lines.push("- (the menu slots are empty)");
  for (const s of rows) {
    const label = s.customName && s.customName !== s.displayName ? `"${s.customName}" (${s.name})` : s.name;
    const lore = s.lore.length ? ` — ${s.lore.join(" / ").slice(0, 160)}` : "";
    lines.push(`- slot ${s.slot} [${s.section}]: ${label} ×${s.count}${lore}`);
  }
  lines.push("Use click_window_slot with a slot number to pick an option, close_window to leave.");
  return lines.join("\n");
}

function requireBot(bot: Bot | null | undefined, online: boolean): Bot {
  if (!bot || !online) throw new PanelError("Bot offline — GUI action unavailable.");
  return bot;
}

function waitForWindow(bot: Bot, ms: number): Promise<WindowLike | null> {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const emitter = bot as unknown as NodeJS.EventEmitter;
    const onOpen = (win: WindowLike) => {
      clearTimeout(timer);
      resolve(win);
    };
    const timer = setTimeout(() => {
      emitter.removeListener("windowOpen", onOpen);
      resolve(null);
    }, ms);
    emitter.once("windowOpen", onOpen);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function clampHotbar(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 8) throw new PanelError("Hotbar slot must be 0-8.");
  return n;
}

/** isimle hotbar'da ara; yoksa envanterden ele al */
async function holdByName(bot: Bot, rawName: string): Promise<string> {
  const name = rawName.trim().toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
  if (!name) throw new PanelError("Item name is empty.");
  const matches = (it: Item | null | undefined) => {
    if (!it) return false;
    if (it.name === name || it.name.includes(name)) return true;
    try {
      const custom = plain((it as unknown as { customName?: unknown }).customName).toLowerCase();
      return Boolean(custom) && custom.includes(rawName.trim().toLowerCase());
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 9; i++) {
    const it = bot.inventory.slots[36 + i];
    if (matches(it)) {
      bot.setQuickBarSlot(i);
      return it!.name;
    }
  }
  const stack = bot.inventory.items().find(matches);
  if (!stack) throw new PanelError(`No "${rawName}" in inventory.`);
  await bot.equip(stack, "hand");
  return stack.name;
}

export interface UseItemInput {
  /** önce bu hotbar slotunu seç (0-8) */
  hotbar?: unknown;
  /** önce bu isimdeki eşyayı ele al (pusula, "server selector" gibi özel ad da olur) */
  item?: unknown;
  offhand?: unknown;
  /** basılı tutma süresi (yemek, yay); 0 = tek sağ tık */
  holdMs?: unknown;
  /** sağ tıktan sonra menü açılmasını bekleme süresi */
  waitWindowMs?: unknown;
}

export interface UseItemResult {
  used: string | null;
  hotbar: number;
  window: WindowSnapshot;
  openedWindow: boolean;
}

/** Eldeki eşyaya sağ tık (pusula → sunucu seçici). İsteğe bağlı önce slot/isim seçer. */
export async function useHeldItem(bot: Bot | null | undefined, online: boolean, input: UseItemInput = {}): Promise<UseItemResult> {
  const b = requireBot(bot, online);
  if (input.hotbar !== undefined && input.hotbar !== null && input.hotbar !== "") b.setQuickBarSlot(clampHotbar(input.hotbar));
  if (typeof input.item === "string" && input.item.trim()) await holdByName(b, input.item);
  const offhand = input.offhand === true || input.offhand === "true";
  const holdMs = Math.max(0, Math.min(5_000, Math.floor(Number(input.holdMs ?? 0) || 0)));
  const waitMs = Math.max(0, Math.min(10_000, Math.floor(Number(input.waitWindowMs ?? 2_000) || 0)));
  const before = currentWindow(b);
  const opened = waitForWindow(b, waitMs);
  const used = offhand ? b.inventory.slots[45]?.name ?? null : b.heldItem?.name ?? null;
  b.activateItem(offhand);
  if (holdMs > 0) {
    await sleep(holdMs);
    b.deactivateItem();
  }
  const win = await opened;
  return { used, hotbar: b.quickBarSlot ?? 0, window: snapshotWindow(b), openedWindow: Boolean(win) && win !== before };
}

export function selectHotbar(bot: Bot | null | undefined, online: boolean, slot: unknown): number {
  const b = requireBot(bot, online);
  const n = clampHotbar(slot);
  b.setQuickBarSlot(n);
  return n;
}

const BUTTONS: Record<ClickButton, { mouseButton: number; mode: number }> = {
  left: { mouseButton: 0, mode: 0 },
  right: { mouseButton: 1, mode: 0 },
  shift: { mouseButton: 0, mode: 1 },
  "shift-right": { mouseButton: 1, mode: 1 },
  middle: { mouseButton: 2, mode: 3 },
  drop: { mouseButton: 0, mode: 4 },
  "drop-stack": { mouseButton: 1, mode: 4 },
  number: { mouseButton: 0, mode: 2 }
};

export function clickButton(value: unknown): ClickButton {
  const key = String(value ?? "left").trim().toLowerCase() as ClickButton;
  if (!(key in BUTTONS)) throw new PanelError(`Unknown click type "${String(value)}" (left, right, shift, shift-right, middle, drop, drop-stack, number).`);
  return key;
}

export interface ClickInput {
  slot?: unknown;
  /** slot yerine: menüdeki eşyanın adı / özel adı / lore parçası (ör. "OneBlock") */
  item?: unknown;
  /** menü henüz açık değilse açılmasını bu kadar bekle (ms, varsayılan 0) */
  waitWindowMs?: unknown;
  button?: unknown;
  /** "number" tıklaması için hedef hotbar (0-8) */
  hotbar?: unknown;
  /** tıklamadan sonra yeni menü / kapanma için bekleme */
  waitMs?: unknown;
  /** bu pencere id'si açık değilse tıklama (yanlış menüye tıklamayı önler) */
  windowId?: unknown;
}

export interface ClickResult {
  clicked: { slot: number; button: ClickButton; item: string | null };
  window: WindowSnapshot;
  changed: "same" | "closed" | "new-window";
}

/** Menüde metne göre slot bulur: önce tam ad eşleşmesi, sonra ad veya lore içinde geçen. */
export function findWindowSlot(snap: WindowSnapshot, query: unknown, sections: WindowItem["section"][] = ["container"]): WindowItem | null {
  const q = String(query ?? "").trim().toLowerCase().replace(/^minecraft:/, "");
  if (!q) return null;
  const items = snap.slots.filter((it): it is WindowItem => Boolean(it) && sections.includes(it!.section));
  const names = (it: WindowItem) => [it.customName ?? "", it.displayName, it.name, it.name.replace(/_/g, " ")].map((n) => n.toLowerCase());
  return (
    items.find((it) => names(it).includes(q)) ??
    items.find((it) => names(it).some((n) => n.includes(q))) ??
    items.find((it) => it.lore.some((line) => line.toLowerCase().includes(q))) ??
    null
  );
}

function clampMs(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  return Math.max(0, Math.min(max, Math.floor(Number(value) || 0)));
}

export async function clickWindowSlot(bot: Bot | null | undefined, online: boolean, input: ClickInput): Promise<ClickResult> {
  const b = requireBot(bot, online);
  const openWait = clampMs(input.waitWindowMs, 0, 15_000);
  if (!currentWindow(b) && openWait > 0) await waitForWindow(b, openWait);
  const win = currentWindow(b);
  if (!win) throw new PanelError(openWait > 0 ? `No GUI window opened within ${openWait} ms.` : "No GUI window is open. Use the held item (right-click) first.");
  if (input.windowId !== undefined && input.windowId !== null && input.windowId !== "" && Number(input.windowId) !== win.id) {
    throw new PanelError(`Window ${String(input.windowId)} is no longer open (current window id ${win.id}).`);
  }
  const bySlot = input.slot !== undefined && input.slot !== null && input.slot !== "";
  let slot = Number(input.slot);
  if (!bySlot) {
    const query = typeof input.item === "string" ? input.item.trim() : "";
    if (!query) throw new PanelError("Give a slot number or the item name to click.");
    // menü eşyaları pencere açıldıktan hemen sonra gelir; kısa bir süre tekrar bak
    const deadline = Date.now() + Math.max(1_500, openWait);
    let hit = findWindowSlot(snapshotWindow(b), query);
    while (!hit && Date.now() < deadline && currentWindow(b) === win) {
      await sleep(100);
      hit = findWindowSlot(snapshotWindow(b), query);
    }
    if (!hit) throw new PanelError(`No menu slot matches "${query}" in "${snapshotWindow(b).title || "the open window"}".`);
    slot = hit.slot;
  }
  const total = Math.max(win.inventoryEnd ?? win.slots.length, win.slots.length);
  if (!Number.isInteger(slot) || slot < 0 || slot >= total) throw new PanelError(`Slot must be 0-${total - 1} for this window.`);
  const button = clickButton(input.button);
  const spec = BUTTONS[button];
  const mouseButton = button === "number" ? clampHotbar(input.hotbar ?? 0) : spec.mouseButton;
  const item = win.slots[slot]?.name ?? null;
  const waitMs = Math.max(0, Math.min(10_000, Math.floor(Number(input.waitMs ?? 1_200) || 0)));
  const next = waitForWindow(b, waitMs);
  // Sunucu menüleri tıklamayı çoğu zaman reddedip eşyayı geri koyar; bu normal.
  // mineflayer'ın "transaction" zaman aşımı hatası menünün işlem yapmadığı anlamına gelmez.
  let clickError: unknown = null;
  const click = b.clickWindow(slot, mouseButton, spec.mode).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/transaction|didn't respond/i.test(msg)) clickError = err;
  });
  await Promise.race([click, sleep(Math.max(waitMs, 2_500))]);
  if (clickError) throw clickError;
  const opened = await next;
  const now = currentWindow(b);
  const changed: ClickResult["changed"] = !now ? "closed" : now !== win || (opened && opened !== win) ? "new-window" : "same";
  return { clicked: { slot, button, item }, window: snapshotWindow(b), changed };
}

export function closeOpenWindow(bot: Bot | null | undefined, online: boolean): boolean {
  const b = requireBot(bot, online);
  const win = currentWindow(b);
  if (!win) return false;
  void Promise.resolve(b.closeWindow(win as never)).catch(() => undefined);
  return true;
}

// ---- tek giriş noktası: REST, socket, toplu işlem ve MCP aynı yolu kullanır ----

export type GuiOp = "use" | "hotbar" | "click" | "close" | "get";

export interface GuiOpInput extends UseItemInput, ClickInput {
  op?: unknown;
}

interface GuiHost {
  bot: Bot | null;
  status: string;
  config: { combat: { hunter?: { enabled?: boolean } } };
}

export type GuiOpResult =
  | { op: "get"; window: WindowSnapshot }
  | { op: "use"; result: UseItemResult }
  | { op: "hotbar"; hotbar: number; held: string | null; window: WindowSnapshot }
  | { op: "click"; result: ClickResult }
  | { op: "close"; closed: boolean; window: WindowSnapshot };

export async function runGuiOp(inst: GuiHost, input: GuiOpInput): Promise<GuiOpResult> {
  const op = String(input.op ?? "").trim().toLowerCase();
  const online = inst.status === "online";
  if (op === "get") return { op: "get", window: snapshotWindow(online ? inst.bot : null) };
  // Hunter modu her şeyi kilitler (BotInstance.enqueueAction ile aynı kural); anti-AFK
  // kilitlemez çünkü menü tıklamak ve sağ tık botu yürütmez.
  if (inst.config.combat.hunter?.enabled) throw new PanelError("Hunter mode is on: other actions are locked.");
  switch (op) {
    case "use":
    case "use-item":
    case "activate":
      return { op: "use", result: await useHeldItem(inst.bot, online, input) };
    case "hotbar":
    case "select-hotbar": {
      const hotbar = selectHotbar(inst.bot, online, input.hotbar ?? input.slot);
      return { op: "hotbar", hotbar, held: inst.bot?.heldItem?.name ?? null, window: snapshotWindow(inst.bot) };
    }
    case "click":
    case "click-slot":
      return { op: "click", result: await clickWindowSlot(inst.bot, online, input) };
    case "close":
    case "close-window": {
      const closed = closeOpenWindow(inst.bot, online);
      return { op: "close", closed, window: snapshotWindow(inst.bot) };
    }
    default:
      throw new PanelError(`Unknown GUI operation: ${op || "(empty)"} (use, hotbar, click, close, get).`);
  }
}

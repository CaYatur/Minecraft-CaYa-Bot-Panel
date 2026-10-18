export type AntiAfkAction = "look" | "sneak" | "jump" | "swing" | "step";
export type AntiAfkMode = "mixed" | AntiAfkAction;

const ANTI_AFK_MODES: AntiAfkMode[] = ["mixed", "look", "sneak", "jump", "swing", "step"];
const ALLOWED_WHILE_ANTI_AFK = new Set([
  "chat",
  "stop",
  "stop-combat",
  "cancel-task",
  "reset-work",
  "reset-all",
  "işleri-sıfırla",
  "soft-reset",
  "stop-build"
]);

export const ANTI_AFK_LOCK = "Anti-AFK is on. Other actions stay locked until you turn it off. Chat still works.";

export function antiAfkMode(value: unknown): AntiAfkMode {
  return ANTI_AFK_MODES.includes(value as AntiAfkMode) ? (value as AntiAfkMode) : "mixed";
}

/** Seconds between moves, stored as milliseconds. */
export function clampAntiAfkInterval(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 45_000;
  return Math.min(600_000, Math.max(5_000, Math.round(n)));
}

/** How long sneak, jump, and step stay held. */
export function clampAntiAfkHold(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 400;
  return Math.min(2_000, Math.max(100, Math.round(n)));
}

export function clampAutostartDelaySec(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(300, Math.max(0, Math.round(n)));
}

export function antiAfkAllowsAction(type: string): boolean {
  return ALLOWED_WHILE_ANTI_AFK.has(type);
}

/** On-ground micro actions. No sprint, fly, or block place. A mode other than mixed repeats one action. */
export function pickAntiAfkAction(random: () => number = Math.random, mode: AntiAfkMode = "mixed"): AntiAfkAction {
  if (mode !== "mixed") return mode;
  const roll = random();
  if (roll < 0.35) return "look";
  if (roll < 0.55) return "sneak";
  if (roll < 0.7) return "swing";
  if (roll < 0.85) return "step";
  return "jump";
}

export function antiAfkAllowed(input: { enabled: boolean; taskRunning: boolean; onGround: boolean }): boolean {
  return input.enabled && !input.taskRunning && input.onGround;
}

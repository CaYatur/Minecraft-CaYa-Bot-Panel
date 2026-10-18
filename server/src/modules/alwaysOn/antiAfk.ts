export type AntiAfkAction = "look" | "sneak" | "jump" | "swing" | "step";
export type AntiAfkMode = "mixed" | AntiAfkAction;

const ANTI_AFK_MODES: AntiAfkMode[] = ["mixed", "look", "sneak", "jump", "swing", "step"];

export function antiAfkMode(value: unknown): AntiAfkMode {
  return ANTI_AFK_MODES.includes(value as AntiAfkMode) ? (value as AntiAfkMode) : "mixed";
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

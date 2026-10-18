export type AntiAfkAction = "look" | "sneak" | "jump" | "swing" | "step";

/** On-ground micro actions. No sprint, fly, or block place. */
export function pickAntiAfkAction(random: () => number = Math.random): AntiAfkAction {
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

import type { Movements } from "mineflayer-pathfinder";

export type PathNode = { x: number; y: number; z: number };

export interface RouteCommit {
  nodes: PathNode[];
  carrot: PathNode;
  setAt: number;
  goalKey: string;
}

type MoveLike = { cost: number; x: number; y: number; z: number };

/**
 * Baritone-style costs on mineflayer-pathfinder:
 * a parkour edge is one node but spans 2–4 blocks — charge the span, not 1.
 * Do not parkour when a walk exists (pathfinder already skips that).
 * Penalize damaging falls and lava/cactus.
 */
export function applySensibleMoveCosts(movements: Movements): void {
  const m = movements as Movements & {
    getMoveParkourForward: (node: { x: number; z: number }, dir: unknown, neighbors: MoveLike[]) => void;
    getMoveDropDown: (node: { y: number }, dir: unknown, neighbors: MoveLike[]) => void;
    exclusionAreasStep: Array<(block: { name?: string }) => number>;
  };
  const origParkour = m.getMoveParkourForward.bind(m);
  m.getMoveParkourForward = (node, dir, neighbors) => {
    const before = neighbors.length;
    origParkour(node, dir, neighbors);
    for (let i = before; i < neighbors.length; i++) {
      const n = neighbors[i]!;
      const span = Math.max(Math.abs(n.x - node.x), Math.abs(n.z - node.z));
      n.cost += Math.max(0, span - 1);
    }
  };
  const origDrop = m.getMoveDropDown.bind(m);
  m.getMoveDropDown = (node, dir, neighbors) => {
    const before = neighbors.length;
    origDrop(node, dir, neighbors);
    for (let i = before; i < neighbors.length; i++) {
      const fall = node.y - neighbors[i]!.y;
      if (fall > 3) neighbors[i]!.cost += (fall - 3) * 4;
    }
  };
  m.exclusionAreasStep.push((block) => {
    const n = String(block?.name ?? "").toLowerCase();
    if (n.includes("lava") || n.includes("magma") || n.includes("cactus") || n === "fire" || n === "soul_fire") return 50;
    return 0;
  });
}

export function goalKeyOf(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x / 6)},${Math.floor(p.y)},${Math.floor(p.z / 6)}`;
}

export function carrotAlong(path: PathNode[], bot: PathNode, lookAhead = 10): PathNode | null {
  if (!path.length) return null;
  let i = 0;
  let best = Infinity;
  for (let k = 0; k < path.length; k++) {
    const n = path[k]!;
    const d = Math.hypot(n.x - bot.x, n.y - bot.y, n.z - bot.z);
    if (d < best) {
      best = d;
      i = k;
    }
  }
  return path[Math.min(path.length - 1, i + lookAhead)]!;
}

export function commitStillValid(commit: RouteCommit, bot: PathNode, goal: PathNode): boolean {
  if (Date.now() - commit.setAt > 22_000) return false;
  if (goalKeyOf(goal) !== commit.goalKey) return false;
  let min = Infinity;
  for (const n of commit.nodes) {
    const d = Math.hypot(n.x - bot.x, n.z - bot.z);
    if (d < min) min = d;
  }
  return min <= 6.5;
}

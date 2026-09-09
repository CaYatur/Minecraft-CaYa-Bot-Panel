import type { Bot } from "mineflayer";
import type { Movements } from "mineflayer-pathfinder";

type JumpRec = { n: number; until: number };
type Mem = { jumps: Map<string, JumpRec> };

const mem = new WeakMap<Bot, Mem>();
const installed = new WeakSet<Bot>();

function getMem(bot: Bot): Mem {
  let m = mem.get(bot);
  if (!m) {
    m = { jumps: new Map() };
    mem.set(bot, m);
  }
  return m;
}

function jumpKey(a: { x: number; z: number }, b: { x: number; z: number }): string {
  return `${Math.floor(a.x)},${Math.floor(a.z)}>${Math.floor(b.x)},${Math.floor(b.z)}`;
}

export function noteJumpFail(bot: Bot, from: { x: number; z: number }, to: { x: number; z: number }): void {
  const m = getMem(bot);
  const k = jumpKey(from, to);
  const now = Date.now();
  const prev = m.jumps.get(k);
  const n = prev && prev.until > now ? prev.n + 1 : 1;
  m.jumps.set(k, { n, until: now + (n >= 2 ? 10 * 60_000 : 3 * 60_000) });
}

export function noteJumpOk(bot: Bot, from: { x: number; z: number }, to: { x: number; z: number }): void {
  getMem(bot).jumps.delete(jumpKey(from, to));
}

export function shouldSkipJump(bot: Bot, from: { x: number; z: number }, to: { x: number; z: number }): boolean {
  const s = getMem(bot).jumps.get(jumpKey(from, to));
  return Boolean(s && s.until > Date.now());
}

function forgetNear(bot: Bot, p: { x: number; z: number }, r = 2): void {
  const m = getMem(bot);
  const fx = Math.floor(p.x);
  const fz = Math.floor(p.z);
  for (const k of [...m.jumps.keys()]) {
    const [a, b] = k.split(">");
    const [ax, az] = (a ?? "").split(",").map(Number);
    const [bx, bz] = (b ?? "").split(",").map(Number);
    if (
      (Math.abs(ax - fx) <= r && Math.abs(az - fz) <= r) ||
      (Math.abs(bx - fx) <= r && Math.abs(bz - fz) <= r)
    ) {
      m.jumps.delete(k);
    }
  }
}

/** Session-only. Block updates wipe nearby fail marks so rebuilt paths are retried. */
export function installTraverseMemory(bot: Bot): void {
  if (installed.has(bot)) return;
  installed.add(bot);
  bot.on("blockUpdate", (oldBlock, newBlock) => {
    const pos = newBlock?.position ?? oldBlock?.position;
    if (pos) forgetNear(bot, pos, 2);
  });
}

/** Make A* treat a failed jump edge as almost never worth taking again. */
export function applyJumpFailCosts(bot: Bot, movements: Movements): void {
  const m = movements as Movements & {
    getMoveParkourForward: (node: { x: number; z: number }, dir: unknown, neighbors: Array<{ x: number; z: number; cost: number }>) => void;
  };
  const orig = m.getMoveParkourForward.bind(m);
  m.getMoveParkourForward = (node, dir, neighbors) => {
    const before = neighbors.length;
    orig(node, dir, neighbors);
    for (let i = before; i < neighbors.length; i++) {
      const n = neighbors[i]!;
      if (shouldSkipJump(bot, node, n)) n.cost += 80;
    }
  };
}

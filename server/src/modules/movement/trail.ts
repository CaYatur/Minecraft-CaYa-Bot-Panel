/**
 * The followed player's trail (issue #34): where they stood, climbed and jumped.
 *
 * When A* cannot find a route to the player inside a build (pillars, ladders,
 * a gap the player jumped), the route the player just used is known to work.
 * Follow walks it in short legs (each a tiny, fast search) and copies the jumps.
 */

export type Vec = { x: number; y: number; z: number };
export type Crumb = Vec & { jumpTo?: Vec };

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class PlayerTrail {
  private crumbs: Crumb[] = [];
  /** absolute index of crumbs[0]; indices stay valid while old crumbs are dropped */
  private base = 0;
  private lastSeen: Vec | null = null;

  constructor(private readonly max = 400, private readonly spacing = 1.2) {}

  get start(): number {
    return this.base;
  }
  get end(): number {
    return this.base + this.crumbs.length; // exclusive
  }
  get size(): number {
    return this.crumbs.length;
  }
  get(i: number): Crumb | undefined {
    return this.crumbs[i - this.base];
  }

  clear(): void {
    this.base += this.crumbs.length;
    this.crumbs = [];
    this.lastSeen = null;
  }

  private push(c: Crumb): void {
    this.crumbs.push(c);
    while (this.crumbs.length > this.max) {
      this.crumbs.shift();
      this.base++;
    }
  }

  /**
   * One sample of the player. Only cells they stood on or climbed are kept.
   * A teleport (big step between samples) breaks the trail: start over.
   */
  record(p: Vec, standing: boolean): void {
    if (this.lastSeen && dist(this.lastSeen, p) > 12) this.clear();
    this.lastSeen = { x: p.x, y: p.y, z: p.z };
    if (!standing) return;
    const last = this.crumbs[this.crumbs.length - 1];
    if (last && dist(last, p) < this.spacing) return;
    this.push({ x: p.x, y: p.y, z: p.z });
  }

  /** A gap jump the player made: the takeoff crumb carries the landing. */
  recordJump(from: Vec, to: Vec): void {
    const last = this.crumbs[this.crumbs.length - 1];
    if (last && dist(last, from) < 0.6) last.jumpTo = { ...to };
    else this.push({ x: from.x, y: from.y, z: from.z, jumpTo: { ...to } });
    this.push({ x: to.x, y: to.y, z: to.z });
    this.lastSeen = { ...to };
  }

  /** Crumbs within maxDist of pos, nearest first (absolute indices). */
  nearestIndices(pos: Vec, maxDist: number, limit = 4): number[] {
    const out: Array<{ i: number; d: number }> = [];
    this.crumbs.forEach((c, k) => {
      const d = dist(c, pos);
      if (d <= maxDist) out.push({ i: this.base + k, d });
    });
    out.sort((a, b) => a.d - b.d || b.i - a.i);
    return out.slice(0, limit).map((o) => o.i);
  }

  /**
   * Next waypoint after crumb i: up to `reach` blocks along the trail, never
   * past a takeoff (that leg is a jump, not a walk). Returns i at the end.
   */
  nextIndex(i: number, reach = 6): number {
    let k = i;
    let walked = 0;
    while (k + 1 < this.end) {
      const a = this.get(k)!;
      if (a.jumpTo) break;
      const b = this.get(k + 1)!;
      walked += dist(a, b);
      if (k > i && walked > reach) break;
      k++;
      if (b.jumpTo) break;
    }
    return k;
  }
}

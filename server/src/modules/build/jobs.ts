import type { SchematicBlock } from "./types";

/**
 * JobBoard: open-block bookkeeping for the build loop.
 * The old implementation filtered/sorted the FULL job array every round
 * (O(n²) on large schematics — 150k blocks froze the loop). This keeps a
 * spatial hash (8³ cells) + per-layer sets so lookups touch only nearby jobs.
 */

export interface BuildJob {
  block: SchematicBlock;
  name: string;
  wx: number;
  wy: number;
  wz: number;
  /** serpentine ordering inside its layer (printer continuity) */
  ord: number;
  done: boolean;
  status?: "placed" | "skipped" | "failed";
  attempts: number;
  retryAt: number;
  /** walk-then-still-out-of-reach count — poison target detection */
  unreachable: number;
  /** re-opened by a repair sweep at least once */
  reopened: boolean;
}

const CELL = 8;

function cellKey(x: number, y: number, z: number): string {
  return `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
}

export class JobBoard {
  readonly all: BuildJob[] = [];
  private open = new Set<BuildJob>();
  private cells = new Map<string, Set<BuildJob>>();
  private layers = new Map<number, Set<BuildJob>>();
  private layerYs: number[] = [];

  constructor(jobs: BuildJob[]) {
    for (const job of jobs) this.add(job);
    this.layerYs = [...this.layers.keys()].sort((a, b) => a - b);
  }

  private add(job: BuildJob) {
    this.all.push(job);
    this.open.add(job);
    const ck = cellKey(job.wx, job.wy, job.wz);
    let cell = this.cells.get(ck);
    if (!cell) {
      cell = new Set();
      this.cells.set(ck, cell);
    }
    cell.add(job);
    let layer = this.layers.get(job.wy);
    if (!layer) {
      layer = new Set();
      this.layers.set(job.wy, layer);
    }
    layer.add(job);
  }

  get openCount(): number {
    return this.open.size;
  }

  isOpen(job: BuildJob): boolean {
    return this.open.has(job);
  }

  complete(job: BuildJob, status: "placed" | "skipped" | "failed") {
    job.done = true;
    job.status = status;
    this.open.delete(job);
    this.cells.get(cellKey(job.wx, job.wy, job.wz))?.delete(job);
    this.layers.get(job.wy)?.delete(job);
  }

  /** Re-open a previously completed job (repair sweep found damage). */
  reopen(job: BuildJob) {
    if (this.open.has(job)) return;
    job.done = false;
    job.status = undefined;
    job.attempts = 0;
    job.unreachable = 0;
    job.retryAt = 0;
    job.reopened = true;
    this.open.add(job);
    const ck = cellKey(job.wx, job.wy, job.wz);
    let cell = this.cells.get(ck);
    if (!cell) {
      cell = new Set();
      this.cells.set(ck, cell);
    }
    cell.add(job);
    let layer = this.layers.get(job.wy);
    if (!layer) {
      layer = new Set();
      this.layers.set(job.wy, layer);
    }
    layer.add(job);
  }

  /** Open jobs within radius r of a point (spatial hash query). */
  nearbyOpen(x: number, y: number, z: number, r: number): BuildJob[] {
    const out: BuildJob[] = [];
    const r2 = r * r;
    const cx0 = Math.floor((x - r) / CELL);
    const cx1 = Math.floor((x + r) / CELL);
    const cy0 = Math.floor((y - r) / CELL);
    const cy1 = Math.floor((y + r) / CELL);
    const cz0 = Math.floor((z - r) / CELL);
    const cz1 = Math.floor((z + r) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const cell = this.cells.get(`${cx},${cy},${cz}`);
          if (!cell) continue;
          for (const job of cell) {
            const dx = job.wx + 0.5 - x;
            const dy = job.wy + 0.5 - y;
            const dz = job.wz + 0.5 - z;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(job);
          }
        }
      }
    }
    return out;
  }

  /** Lowest layer that still has open jobs (printer mode floor). */
  lowestOpenY(): number | null {
    for (const y of this.layerYs) {
      const layer = this.layers.get(y);
      if (layer && layer.size > 0) return y;
    }
    return null;
  }

  /** Open layers from bottom, up to `count` layers (printer look-ahead). */
  openLayersFrom(count: number): number[] {
    const out: number[] = [];
    for (const y of this.layerYs) {
      const layer = this.layers.get(y);
      if (layer && layer.size > 0) {
        out.push(y);
        if (out.length >= count) break;
      }
    }
    return out;
  }

  openInLayer(y: number): BuildJob[] {
    const layer = this.layers.get(y);
    return layer ? [...layer] : [];
  }

  /** Iterate ALL open jobs — use sparingly (missing-material summary etc.). */
  openJobs(): BuildJob[] {
    return [...this.open];
  }

  /** Nearest open job to a point without a radius bound (expanding rings, then full fallback). */
  nearestOpen(
    x: number,
    y: number,
    z: number,
    accept: (job: BuildJob) => boolean
  ): BuildJob | null {
    for (const r of [8, 16, 32, 64, 128]) {
      const cands = this.nearbyOpen(x, y, z, r).filter(accept);
      if (cands.length) {
        let best: BuildJob | null = null;
        let bestD = Infinity;
        for (const job of cands) {
          const d = Math.hypot(job.wx + 0.5 - x, job.wy + 0.5 - y, job.wz + 0.5 - z);
          if (d < bestD) {
            bestD = d;
            best = job;
          }
        }
        return best;
      }
    }
    let best: BuildJob | null = null;
    let bestD = Infinity;
    for (const job of this.open) {
      if (!accept(job)) continue;
      const d = Math.hypot(job.wx + 0.5 - x, job.wy + 0.5 - y, job.wz + 0.5 - z);
      if (d < bestD) {
        bestD = d;
        best = job;
      }
    }
    return best;
  }
}

/**
 * Layer-by-layer serpentine ordering (3D printer path): z rows bottom-up,
 * alternating x direction per row. Returns jobs with `ord` assigned.
 */
export function orderBlocksPrinter(blocks: SchematicBlock[]): SchematicBlock[] {
  const byY = new Map<number, SchematicBlock[]>();
  for (const b of blocks) {
    const list = byY.get(b.dy) ?? [];
    list.push(b);
    byY.set(b.dy, list);
  }
  const ys = [...byY.keys()].sort((a, b) => a - b);
  const out: SchematicBlock[] = [];
  for (const y of ys) {
    const layer = byY.get(y)!;
    const rows = new Map<number, SchematicBlock[]>();
    for (const b of layer) {
      const r = rows.get(b.dz) ?? [];
      r.push(b);
      rows.set(b.dz, r);
    }
    const zs = [...rows.keys()].sort((a, b) => a - b);
    let flip = false;
    for (const z of zs) {
      const row = rows.get(z)!;
      row.sort((a, b) => (flip ? b.dx - a.dx : a.dx - b.dx));
      out.push(...row);
      flip = !flip;
    }
  }
  return out;
}

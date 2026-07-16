import type { BotInstance } from "../../core/BotInstance";
import { dist3, isAirLike, sleep } from "./maneuver";
import { digCancelable, pathNear, PLACE_REACH, stepAside } from "./place";
import { equipBestToolForBlock, isScaffoldFamily, pickScaffoldItem } from "./tools";
import { v3 } from "./vec3util";

export interface ScaffoldRecord {
  x: number;
  y: number;
  z: number;
  name: string;
}

/**
 * Scaffold ledger: temporary blocks placed during a build.
 * Cells that received a real structure block are protected — the cleanup
 * pass will never dig them.
 */
export class ScaffoldTracker {
  private stack: ScaffoldRecord[] = [];
  /** structure landed here → never dig */
  private protectedCells = new Set<string>();

  get count(): number {
    return this.stack.length;
  }

  get records(): readonly ScaffoldRecord[] {
    return this.stack;
  }

  private key(x: number, y: number, z: number) {
    return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  }

  record(x: number, y: number, z: number, name: string) {
    const k = this.key(x, y, z);
    if (this.protectedCells.has(k)) return; // structure cell is not scaffold
    if (this.stack.some((r) => this.key(r.x, r.y, r.z) === k)) return;
    this.stack.push({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), name });
  }

  isProtected(x: number, y: number, z: number): boolean {
    return this.protectedCells.has(this.key(x, y, z));
  }

  /** A permanent structure block landed here — drop the scaffold record and protect. */
  protectStructure(x: number, y: number, z: number) {
    const k = this.key(x, y, z);
    this.protectedCells.add(k);
    this.stack = this.stack.filter((r) => this.key(r.x, r.y, r.z) !== k);
  }

  /** Take the current records out (cleanup consumes them). */
  drain(): ScaffoldRecord[] {
    const out = this.stack;
    this.stack = [];
    return out;
  }

  clear() {
    this.stack = [];
    this.protectedCells.clear();
  }
}

export interface ScaffoldCleanupResult {
  /** actually removed (or already gone) */
  cleared: number;
  /** could not be removed — reported honestly, not silently counted */
  left: number;
}

/**
 * Remove temporary blocks top-down. Unlike the old version this
 * - walks to scaffolds that are out of reach instead of skipping them,
 * - steps aside when standing inside the target cell,
 * - reports blocks it could NOT remove instead of counting them as cleared.
 * Drop pickup is the caller's job (onDigged hook) to avoid module cycles.
 */
export async function cleanupScaffolds(
  instance: BotInstance,
  tracker: ScaffoldTracker,
  token: { cancelled: boolean; reason?: string },
  opts?: {
    onProgress?: (cleared: number, left: number, total: number) => void;
    /** called after every few digs so the caller can vacuum drops */
    onDigged?: (count: number) => Promise<void> | void;
  }
): Promise<ScaffoldCleanupResult> {
  const bot = instance.bot;
  const records = tracker.drain();
  const total = records.length;
  let cleared = 0;
  let left = 0;
  if (!bot || instance.status !== "online") {
    return { cleared: 0, left: total };
  }

  // top-down, then near-first inside the same layer
  const ordered = records.sort(
    (a, b) => b.y - a.y || dist3(bot, a.x + 0.5, a.y + 0.5, a.z + 0.5) - dist3(bot, b.x + 0.5, b.y + 0.5, b.z + 0.5)
  );

  let digsSinceSweep = 0;
  for (const rec of ordered) {
    if (token.cancelled) break;
    if (tracker.isProtected(rec.x, rec.y, rec.z)) {
      cleared++; // structure claimed the cell — nothing to remove
      opts?.onProgress?.(cleared, left, total);
      continue;
    }
    const pos = v3(rec.x, rec.y, rec.z);
    let b = bot.blockAt(pos);
    if (!b || isAirLike(b.name)) {
      cleared++;
      opts?.onProgress?.(cleared, left, total);
      continue;
    }
    // only dig scaffold-family blocks still in the cell — never structure blocks
    if (b.name !== rec.name && !isScaffoldFamily(b.name)) {
      cleared++; // someone replaced it — not ours anymore
      opts?.onProgress?.(cleared, left, total);
      continue;
    }

    try {
      // standing inside the cell → move off first
      const feet = bot.entity.position;
      if (Math.floor(feet.x) === rec.x && Math.floor(feet.y) === rec.y && Math.floor(feet.z) === rec.z) {
        await stepAside(instance, token, pos);
      }
      // out of reach → walk over (old version silently skipped these)
      if (dist3(bot, rec.x + 0.5, rec.y + 0.5, rec.z + 0.5) > PLACE_REACH) {
        await pathNear(instance, rec.x + 0.5, rec.y, rec.z + 0.5, 2.8, token, {
          clearGoal: true,
          timeoutMs: 9_000
        });
      }
      b = bot.blockAt(pos);
      if (!b || isAirLike(b.name)) {
        cleared++;
        opts?.onProgress?.(cleared, left, total);
        continue;
      }
      if (!bot.canDigBlock(b)) {
        left++;
        opts?.onProgress?.(cleared, left, total);
        continue;
      }
      await equipBestToolForBlock(bot, b);
      await digCancelable(bot, b, token);
      await sleep(40);
      const after = bot.blockAt(pos);
      if (!after || isAirLike(after.name)) {
        cleared++;
        digsSinceSweep++;
        if (digsSinceSweep >= 5 && opts?.onDigged) {
          digsSinceSweep = 0;
          try {
            await opts.onDigged(cleared);
          } catch {
            /* drop sweep is best-effort */
          }
        }
      } else {
        left++;
      }
    } catch {
      left++;
    }
    opts?.onProgress?.(cleared, left, total);
  }

  if (opts?.onDigged && digsSinceSweep > 0 && !token.cancelled) {
    try {
      await opts.onDigged(cleared);
    } catch {
      /* */
    }
  }
  return { cleared, left };
}

// re-exports for compatibility (helpers moved to ./tools)
export { equipBestToolForBlock, isScaffoldFamily, pickScaffoldItem };

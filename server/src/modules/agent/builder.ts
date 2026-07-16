import type { SchematicBlock } from "../build/types";

/**
 * Creative (schematic-free) building for the agent: the model composes a
 * structure from parametric shapes and/or raw relative blocks. Shapes are
 * applied in order into a voxel map; `block: "air"` carves (removes) cells,
 * which gives the model boolean subtraction for doors, windows and interiors.
 *
 * Coordinates are RELATIVE to the build origin: dx east, dy up, dz south.
 * The result feeds the existing BuildService (realistic placement, scaffolds,
 * material accounting) — the agent never places blocks by teleport/cheat.
 */

export interface ShapeOp {
  shape:
    | "box"
    | "hollow_box"
    | "floor"
    | "wall"
    | "pillar"
    | "line"
    | "cylinder"
    | "sphere"
    | "dome"
    | "pyramid"
    | "cone"
    | "stairs"
    | "roof_gable"
    | "ring"
    | "blocks";
  /** minecraft block name; "air" carves previously placed cells */
  block?: string;
  /** shape origin offset (min corner / center for radial shapes) */
  at?: { dx?: number; dy?: number; dz?: number };
  /** box/floor/wall/pyramid/roof dimensions */
  width?: number; // x
  height?: number; // y
  length?: number; // z
  /** radial shapes */
  radius?: number;
  /** line endpoint (relative, inclusive) */
  to?: { dx?: number; dy?: number; dz?: number };
  /** wall/stairs/roof orientation: which horizontal axis they run along */
  axis?: "x" | "z";
  /** stairs direction along axis (+1/-1) */
  direction?: 1 | -1;
  hollow?: boolean;
  /** raw voxels for shape "blocks" */
  cells?: Array<{ dx: number; dy: number; dz: number; block?: string; name?: string }>;
}

export const MAX_AGENT_BUILD_BLOCKS = 30_000;
const MAX_DIM = 200;

export function composeShapes(ops: ShapeOp[], cap = MAX_AGENT_BUILD_BLOCKS): SchematicBlock[] {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error("shapes: en az bir şekil gerekli");
  if (ops.length > 200) throw new Error("shapes: en fazla 200 şekil");
  const map = new Map<string, string>();
  for (const op of ops) applyShape(map, op);
  if (map.size === 0) throw new Error("Şekiller hiç blok üretmedi (hepsi air ile oyulmuş olabilir)");
  if (map.size > cap) throw new Error(`Blok limiti aşıldı: ${map.size} > ${cap}`);
  const out: SchematicBlock[] = [];
  for (const [key, name] of map) {
    const [dx, dy, dz] = key.split(",").map(Number);
    out.push({ dx: dx!, dy: dy!, dz: dz!, name });
  }
  return out;
}

function applyShape(map: Map<string, string>, op: ShapeOp) {
  const block = normBlock(op.block ?? (op.shape === "blocks" ? "" : undefined));
  const at = { x: int(op.at?.dx), y: int(op.at?.dy), z: int(op.at?.dz) };
  const put = (x: number, y: number, z: number, b = block) => setCell(map, at.x + x, at.y + y, at.z + z, b);

  switch (op.shape) {
    case "blocks": {
      const cells = op.cells ?? [];
      if (!cells.length) throw new Error("blocks şekli için cells listesi gerekli");
      if (cells.length > MAX_AGENT_BUILD_BLOCKS) throw new Error("cells çok büyük");
      for (const c of cells) {
        const b = normBlock(c.block ?? c.name ?? op.block);
        setCell(map, at.x + int(c.dx), at.y + int(c.dy), at.z + int(c.dz), b);
      }
      return;
    }
    case "box":
    case "hollow_box": {
      const { w, h, l } = dims(op, 1);
      const hollow = op.shape === "hollow_box" || op.hollow === true;
      for (let x = 0; x < w; x++)
        for (let y = 0; y < h; y++)
          for (let z = 0; z < l; z++) {
            if (hollow && x > 0 && x < w - 1 && y > 0 && y < h - 1 && z > 0 && z < l - 1) continue;
            put(x, y, z);
          }
      return;
    }
    case "floor": {
      const { w, l } = dims(op, 1);
      for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) put(x, 0, z);
      return;
    }
    case "wall": {
      // a single flat wall along `axis`, thickness 1
      const axis = op.axis === "z" ? "z" : "x";
      const len = clampDim(axis === "x" ? (op.width ?? op.length) : (op.length ?? op.width), 1);
      const h = clampDim(op.height, 1);
      for (let i = 0; i < len; i++)
        for (let y = 0; y < h; y++) (axis === "x" ? put(i, y, 0) : put(0, y, i));
      return;
    }
    case "pillar": {
      const h = clampDim(op.height, 1);
      for (let y = 0; y < h; y++) put(0, y, 0);
      return;
    }
    case "line": {
      const to = { x: int(op.to?.dx), y: int(op.to?.dy), z: int(op.to?.dz) };
      const steps = Math.max(Math.abs(to.x), Math.abs(to.y), Math.abs(to.z));
      if (steps > MAX_DIM * 2) throw new Error("line çok uzun");
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        put(Math.round(to.x * t), Math.round(to.y * t), Math.round(to.z * t));
      }
      return;
    }
    case "cylinder":
    case "ring": {
      const r = clampRadius(op.radius);
      const h = op.shape === "ring" ? 1 : clampDim(op.height, 1);
      const hollow = op.shape === "ring" || op.hollow === true;
      for (let x = -r; x <= r; x++)
        for (let z = -r; z <= r; z++) {
          const d = Math.sqrt(x * x + z * z);
          const inside = d <= r + 0.4;
          const shell = d >= r - 0.6 && d <= r + 0.4;
          if (hollow ? shell : inside) for (let y = 0; y < h; y++) put(x, y, z);
        }
      return;
    }
    case "sphere":
    case "dome": {
      const r = clampRadius(op.radius);
      const hollow = op.hollow !== false; // default hollow (solid spheres are rarely wanted)
      const yMin = op.shape === "dome" ? 0 : -r;
      for (let x = -r; x <= r; x++)
        for (let y = yMin; y <= r; y++)
          for (let z = -r; z <= r; z++) {
            const d = Math.sqrt(x * x + y * y + z * z);
            const inside = d <= r + 0.4;
            const shell = d >= r - 0.6 && d <= r + 0.4;
            if (hollow ? shell : inside) put(x, y, z);
          }
      return;
    }
    case "pyramid":
    case "cone": {
      const r0 = op.radius != null ? clampRadius(op.radius) : Math.floor(clampDim(op.width, 3) / 2);
      const h = clampDim(op.height ?? r0 + 1, 1);
      const hollow = op.hollow === true;
      for (let y = 0; y < h; y++) {
        const r = Math.max(0, Math.round(r0 * (1 - y / h)));
        for (let x = -r; x <= r; x++)
          for (let z = -r; z <= r; z++) {
            if (op.shape === "cone" && Math.sqrt(x * x + z * z) > r + 0.4) continue;
            if (hollow && y < h - 1) {
              const edge =
                op.shape === "cone"
                  ? Math.sqrt(x * x + z * z) >= r - 0.6
                  : Math.abs(x) === r || Math.abs(z) === r;
              if (!edge) continue;
            }
            put(x, y, z);
          }
      }
      return;
    }
    case "stairs": {
      // straight staircase: each step 1 higher, `width` wide, run along axis
      const axis = op.axis === "z" ? "z" : "x";
      const dir = op.direction === -1 ? -1 : 1;
      const h = clampDim(op.height, 1);
      const w = clampDim(op.width, 1);
      for (let i = 0; i < h; i++)
        for (let side = 0; side < w; side++) {
          if (axis === "x") put(i * dir, i, side);
          else put(side, i, i * dir);
        }
      return;
    }
    case "roof_gable": {
      // two sloped strips meeting at a ridge; spans `width` across, `length` along axis
      const axis = op.axis === "z" ? "z" : "x";
      const span = clampDim(op.width, 2);
      const len = clampDim(op.length, 1);
      const levels = Math.ceil(span / 2);
      for (let lv = 0; lv < levels; lv++) {
        const a = lv;
        const b = span - 1 - lv;
        for (let j = 0; j < len; j++) {
          if (axis === "x") {
            put(j, lv, a);
            if (b !== a) put(j, lv, b);
          } else {
            put(a, lv, j);
            if (b !== a) put(b, lv, j);
          }
        }
      }
      return;
    }
    default:
      throw new Error(`Bilinmeyen şekil: ${String((op as { shape?: unknown }).shape)}`);
  }
}

function setCell(map: Map<string, string>, x: number, y: number, z: number, block: string | undefined) {
  if (!block) throw new Error("block adı gerekli");
  if (Math.abs(x) > MAX_DIM || Math.abs(z) > MAX_DIM || y < -64 || y > 320) {
    throw new Error(`Blok origin'den çok uzak: ${x},${y},${z} (±${MAX_DIM})`);
  }
  const key = `${x},${y},${z}`;
  if (block === "air" || block === "cave_air") map.delete(key);
  else {
    if (map.size >= MAX_AGENT_BUILD_BLOCKS && !map.has(key)) {
      throw new Error(`Blok limiti aşıldı (${MAX_AGENT_BUILD_BLOCKS})`);
    }
    map.set(key, block);
  }
}

function normBlock(b: unknown): string | undefined {
  if (b == null) return undefined;
  const s = String(b).trim().toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
  return s || undefined;
}
function int(v: unknown): number {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}
function dims(op: ShapeOp, min: number): { w: number; h: number; l: number } {
  return { w: clampDim(op.width, min), h: clampDim(op.height, min), l: clampDim(op.length, min) };
}
function clampDim(v: unknown, min: number): number {
  const n = Math.round(Number(v ?? min));
  if (!Number.isFinite(n) || n < min) return min;
  if (n > MAX_DIM) throw new Error(`Boyut çok büyük (maks ${MAX_DIM})`);
  return n;
}
function clampRadius(v: unknown): number {
  const n = Math.round(Number(v ?? 1));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 60) throw new Error("Yarıçap çok büyük (maks 60)");
  return n;
}

/** quick material summary for plan/preview responses */
export function summarizeMaterials(blocks: SchematicBlock[]): Array<{ name: string; count: number }> {
  const m = new Map<string, number>();
  for (const b of blocks) m.set(b.name, (m.get(b.name) ?? 0) + 1);
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function boundsOf(blocks: SchematicBlock[]): { w: number; h: number; l: number } {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const b of blocks) {
    minX = Math.min(minX, b.dx);
    minY = Math.min(minY, b.dy);
    minZ = Math.min(minZ, b.dz);
    maxX = Math.max(maxX, b.dx);
    maxY = Math.max(maxY, b.dy);
    maxZ = Math.max(maxZ, b.dz);
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0, l: 0 };
  return { w: maxX - minX + 1, h: maxY - minY + 1, l: maxZ - minZ + 1 };
}

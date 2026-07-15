import type { SchematicBlock } from "./types";

export type RotateY = 0 | 90 | 180 | 270;

export interface BuildTransform {
  /** Y ekseni etrafında saat yönü (üstten bakınca) derece */
  rotateY?: RotateY;
  /** X eksenine göre aynala (dx → -dx) */
  mirrorX?: boolean;
  /** Z eksenine göre aynala (dz → -dz) */
  mirrorZ?: boolean;
}

const FACING_CW = ["north", "east", "south", "west"] as const;

/**
 * Göreli blokları döndür / aynala + yaygın block-state (facing/axis) dönüşümü.
 * Sonra 0-tabanlı köşeye normalize et.
 */
export function applyTransform(
  blocks: SchematicBlock[],
  transform: BuildTransform = {}
): { blocks: SchematicBlock[]; width: number; height: number; length: number } {
  const rot = (Number(transform.rotateY) || 0) as RotateY;
  const mx = Boolean(transform.mirrorX);
  const mz = Boolean(transform.mirrorZ);

  let mapped = blocks.map((b) => {
    let { dx, dy, dz } = b;
    if (mx) dx = -dx;
    if (mz) dz = -dz;
    const [rx, rz] = rotateY(dx, dz, rot);
    const properties = transformProperties(b.properties, rot, mx, mz);
    return { ...b, dx: rx, dy, dz: rz, properties };
  });

  if (!mapped.length) {
    return { blocks: [], width: 0, height: 0, length: 0 };
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const b of mapped) {
    minX = Math.min(minX, b.dx);
    minY = Math.min(minY, b.dy);
    minZ = Math.min(minZ, b.dz);
    maxX = Math.max(maxX, b.dx);
    maxY = Math.max(maxY, b.dy);
    maxZ = Math.max(maxZ, b.dz);
  }

  mapped = mapped.map((b) => ({
    ...b,
    dx: b.dx - minX,
    dy: b.dy - minY,
    dz: b.dz - minZ
  }));

  return {
    blocks: mapped,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    length: maxZ - minZ + 1
  };
}

function rotateY(x: number, z: number, deg: RotateY): [number, number] {
  switch (deg) {
    case 90:
      return [-z, x];
    case 180:
      return [-x, -z];
    case 270:
      return [z, -x];
    default:
      return [x, z];
  }
}

/** facing / axis / hinge vb. state dönüşümü */
export function transformProperties(
  props: Record<string, string | number | boolean> | undefined,
  rot: RotateY,
  mirrorX: boolean,
  mirrorZ: boolean
): Record<string, string | number | boolean> | undefined {
  if (!props || (!rot && !mirrorX && !mirrorZ)) return props ? { ...props } : undefined;
  const out: Record<string, string | number | boolean> = { ...props };

  const steps = rot === 90 ? 1 : rot === 180 ? 2 : rot === 270 ? 3 : 0;

  const mapFacing = (f: string): string => {
    let v = f.toLowerCase();
    if (v === "up" || v === "down") return v;
    // mirror first (world axes before rotation of block facing)
    if (mirrorX) {
      if (v === "east") v = "west";
      else if (v === "west") v = "east";
    }
    if (mirrorZ) {
      if (v === "north") v = "south";
      else if (v === "south") v = "north";
    }
    const i = FACING_CW.indexOf(v as (typeof FACING_CW)[number]);
    if (i < 0) return f;
    return FACING_CW[(i + steps) % 4]!;
  };

  for (const key of ["facing", "facing_horizontal", "rotation"] as const) {
    // rotation 0-15 for signs — skip numeric heavy
    if (key === "rotation" && typeof out[key] === "number") continue;
    if (typeof out[key] === "string") out[key] = mapFacing(String(out[key]));
  }

  // axis for logs/pillars: x <-> z on 90/270
  if (typeof out.axis === "string") {
    const a = String(out.axis).toLowerCase();
    if (a === "x" || a === "z") {
      if (steps % 2 === 1) out.axis = a === "x" ? "z" : "x";
    }
  }

  // door hinge left/right with mirror
  if (typeof out.hinge === "string" && (mirrorX || mirrorZ)) {
    const h = String(out.hinge).toLowerCase();
    if (h === "left") out.hinge = "right";
    else if (h === "right") out.hinge = "left";
  }

  // rail shape north_south / east_west
  if (typeof out.shape === "string") {
    let s = String(out.shape).toLowerCase();
    if (mirrorX || mirrorZ || steps) {
      const swapNS = (t: string) =>
        t
          .replace(/north/g, "TMPN")
          .replace(/south/g, "north")
          .replace(/TMPN/g, "south");
      const swapEW = (t: string) =>
        t
          .replace(/east/g, "TMPE")
          .replace(/west/g, "east")
          .replace(/TMPE/g, "west");
      if (mirrorZ) s = swapNS(s);
      if (mirrorX) s = swapEW(s);
      if (steps === 1 || steps === 3) {
        s = s
          .replace(/north_south/g, "TMP_NS")
          .replace(/east_west/g, "north_south")
          .replace(/TMP_NS/g, "east_west");
        // corner shapes approximate
        s = s
          .replace(/north_east/g, "TMP")
          .replace(/south_east/g, "north_east")
          .replace(/south_west/g, "south_east")
          .replace(/north_west/g, "south_west")
          .replace(/TMP/g, "north_west");
        if (steps === 3) {
          // another 180 via two 90 — already one 90; apply again for 270
          s = s
            .replace(/north_south/g, "TMP_NS")
            .replace(/east_west/g, "north_south")
            .replace(/TMP_NS/g, "east_west");
        }
      } else if (steps === 2) {
        s = swapNS(swapEW(s));
      }
      out.shape = s;
    }
  }

  return out;
}

export function normalizeRotateY(v: unknown): RotateY {
  const n = Number(v) || 0;
  const r = ((n % 360) + 360) % 360;
  if (r === 90 || r === 180 || r === 270) return r;
  return 0;
}

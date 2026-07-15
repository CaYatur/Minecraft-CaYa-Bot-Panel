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

/**
 * Göreli blokları döndür / aynala, sonra 0-tabanlı köşeye normalize et.
 * Block state property dönüşümü v1’de yok (sadece konum).
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
    return { ...b, dx: rx, dy, dz: rz };
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

export function normalizeRotateY(v: unknown): RotateY {
  const n = Number(v) || 0;
  const r = ((n % 360) + 360) % 360;
  if (r === 90 || r === 180 || r === 270) return r;
  return 0;
}

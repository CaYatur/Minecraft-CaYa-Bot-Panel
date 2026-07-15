/**
 * Litematica (.litematic) NBT okuyucu.
 * Format: Regions → her bölge Size/Position + BlockStatePalette + BlockStates (packed longs).
 * @see https://github.com/maruohon/litematica
 */
import type { SchematicBlock } from "./types";

export interface LitematicParseResult {
  blocks: SchematicBlock[];
  width: number;
  height: number;
  length: number;
  regionCount: number;
  name?: string;
}

/** Maks. blok (DoS / bellek) */
export const MAX_LITEMATIC_BLOCKS = 150_000;

export async function parseLitematicBuffer(buf: Buffer): Promise<LitematicParseResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nbt = require("prismarine-nbt") as {
    parse: (b: Buffer) => Promise<{ parsed: unknown }>;
    simplify: (n: unknown) => Record<string, unknown>;
  };

  const { parsed } = await nbt.parse(buf);
  const root = nbt.simplify(parsed) as Record<string, unknown>;

  const regionsRaw = root.Regions as Record<string, RegionRaw> | undefined;
  if (!regionsRaw || typeof regionsRaw !== "object") {
    throw new Error("Litematic: Regions not found — file corrupt or unsupported version");
  }

  const all: SchematicBlock[] = [];
  let regionCount = 0;

  for (const [regionName, region] of Object.entries(regionsRaw)) {
    regionCount++;
    if (!region || typeof region !== "object") continue;
    const size = asVec3(region.Size);
    const pos = asVec3(region.Position ?? { x: 0, y: 0, z: 0 });
    // Size negatif olabilir (Litematica yön işareti)
    const sizeX = Math.abs(size.x) || 1;
    const sizeY = Math.abs(size.y) || 1;
    const sizeZ = Math.abs(size.z) || 1;
    const ox = size.x < 0 ? pos.x + size.x + 1 : pos.x;
    const oy = size.y < 0 ? pos.y + size.y + 1 : pos.y;
    const oz = size.z < 0 ? pos.z + size.z + 1 : pos.z;

    const palette = normalizePalette(region.BlockStatePalette);
    if (!palette.length) continue;

    const packed = normalizeLongArray(region.BlockStates);
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(palette.length, 2))));
    const volume = sizeX * sizeY * sizeZ;
    if (volume > MAX_LITEMATIC_BLOCKS) {
      throw new Error(`Litematic region too large (${volume} > ${MAX_LITEMATIC_BLOCKS})`);
    }

    for (let i = 0; i < volume; i++) {
      const idx = extractPaletteIndex(packed, i, bits);
      if (idx < 0 || idx >= palette.length) continue;
      const entry = palette[idx]!;
      const name = entry.name.replace(/^minecraft:/, "");
      if (!name || name === "air" || name === "cave_air" || name === "void_air" || name === "structure_void") continue;

      // Litematica index: y * (x*z) + z * x + x  (common layout)
      const y = Math.floor(i / (sizeX * sizeZ));
      const rem = i - y * sizeX * sizeZ;
      const z = Math.floor(rem / sizeX);
      const x = rem - z * sizeX;

      all.push({
        dx: ox + x,
        dy: oy + y,
        dz: oz + z,
        name,
        properties: entry.properties
      });

      if (all.length > MAX_LITEMATIC_BLOCKS) {
        throw new Error(`Litematic total block limit exceeded (${MAX_LITEMATIC_BLOCKS})`);
      }
    }

    // regionName unused except debug
    void regionName;
  }

  if (!all.length) throw new Error("Litematic: no placeable blocks (empty schematic?)");

  // normalize to 0-based
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const b of all) {
    minX = Math.min(minX, b.dx);
    minY = Math.min(minY, b.dy);
    minZ = Math.min(minZ, b.dz);
    maxX = Math.max(maxX, b.dx);
    maxY = Math.max(maxY, b.dy);
    maxZ = Math.max(maxZ, b.dz);
  }

  const blocks = all.map((b) => ({
    ...b,
    dx: b.dx - minX,
    dy: b.dy - minY,
    dz: b.dz - minZ
  }));

  const metaName =
    (root.Metadata as { Name?: string } | undefined)?.Name ||
    (root.Metadata as { name?: string } | undefined)?.name;

  return {
    blocks,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    length: maxZ - minZ + 1,
    regionCount,
    name: typeof metaName === "string" ? metaName : undefined
  };
}

interface RegionRaw {
  Size?: { x?: number; y?: number; z?: number };
  Position?: { x?: number; y?: number; z?: number };
  BlockStatePalette?: unknown;
  BlockStates?: unknown;
}

interface PaletteEntry {
  name: string;
  properties?: Record<string, string | number | boolean>;
}

function asVec3(v: unknown): { x: number; y: number; z: number } {
  if (!v || typeof v !== "object") return { x: 0, y: 0, z: 0 };
  const o = v as Record<string, unknown>;
  return {
    x: Number(o.x ?? o.X ?? 0) || 0,
    y: Number(o.y ?? o.Y ?? 0) || 0,
    z: Number(o.z ?? o.Z ?? 0) || 0
  };
}

function normalizePalette(raw: unknown): PaletteEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    if (!e || typeof e !== "object") return { name: "air" };
    const o = e as Record<string, unknown>;
    const name = String(o.Name ?? o.name ?? "air");
    const propsRaw = (o.Properties ?? o.properties) as Record<string, unknown> | undefined;
    let properties: Record<string, string | number | boolean> | undefined;
    if (propsRaw && typeof propsRaw === "object") {
      properties = {};
      for (const [k, v] of Object.entries(propsRaw)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") properties[k] = v;
        else properties[k] = String(v);
      }
    }
    return { name, properties };
  });
}

/** Java long[] → BigInt[] (unsigned 64-bit) */
function normalizeLongArray(raw: unknown): bigint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => {
    if (typeof v === "bigint") return v < 0n ? v + 0x10000000000000000n : v;
    if (typeof v === "number") {
      // precision loss possible for large; still try
      const n = BigInt(Math.trunc(v));
      return n < 0n ? n + 0x10000000000000000n : n;
    }
    if (v && typeof v === "object") {
      // prismarine sometimes { [0]: hi, [1]: lo } or {low, high}
      const o = v as { low?: number; high?: number; [k: number]: number };
      if (typeof o.low === "number" && typeof o.high === "number") {
        const lo = BigInt(o.low >>> 0);
        const hi = BigInt(o.high >>> 0);
        return (hi << 32n) | lo;
      }
      if (typeof o[0] === "number" && typeof o[1] === "number") {
        // often [high, low] in some nbt libs — try both common orders
        const a = BigInt(o[0] >>> 0);
        const b = BigInt(o[1] >>> 0);
        return (a << 32n) | b;
      }
    }
    try {
      return BigInt(String(v));
    } catch {
      return 0n;
    }
  });
}

/**
 * Packed bit stream across longs (Java BitArray style used by Litematica/Minecraft).
 * Index i uses bits [i*bits, (i+1)*bits).
 */
function extractPaletteIndex(longs: bigint[], blockIndex: number, bits: number): number {
  if (!longs.length || bits <= 0) return 0;
  const bitIndex = BigInt(blockIndex * bits);
  const longIndex = Number(bitIndex / 64n);
  const bitOffset = Number(bitIndex % 64n);
  const mask = (1n << BigInt(bits)) - 1n;

  if (longIndex >= longs.length) return 0;

  if (bitOffset + bits <= 64) {
    return Number((longs[longIndex]! >> BigInt(bitOffset)) & mask);
  }
  // spans two longs
  const lowBits = 64 - bitOffset;
  const low = longs[longIndex]! >> BigInt(bitOffset);
  const high = longIndex + 1 < longs.length ? longs[longIndex + 1]! : 0n;
  const combined = low | (high << BigInt(lowBits));
  return Number(combined & mask);
}

/** gzip magic or raw nbt for .litematic sniff */
export function looksLikeLitematic(buf: Buffer, filename?: string): boolean {
  const lower = (filename ?? "").toLowerCase();
  if (lower.endsWith(".litematic")) return true;
  // gzip
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return true;
  return false;
}

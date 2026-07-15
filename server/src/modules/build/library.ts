import * as fs from "fs";
import * as path from "path";
import { SCHEMATICS_DIR, SCHEMATICS_FILES_DIR } from "../../config/paths";
import { newId } from "../../types";
import type { ParsedSchematic, SchematicBlock, SchematicFormat, SchematicMeta } from "./types";

const INDEX_PATH = path.join(SCHEMATICS_DIR, "index.json");

interface IndexFile {
  items: SchematicMeta[];
}

function readIndex(): IndexFile {
  try {
    if (!fs.existsSync(INDEX_PATH)) return { items: [] };
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) as IndexFile;
    return { items: Array.isArray(raw.items) ? raw.items : [] };
  } catch {
    return { items: [] };
  }
}

function writeIndex(idx: IndexFile) {
  const tmp = INDEX_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
  fs.renameSync(tmp, INDEX_PATH);
}

function safeFilename(name: string, ext: string): string {
  const base = name
    .replace(/[^a-zA-Z0-9_\-\u00C0-\u024F]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64) || "schema";
  return `${base}_${Date.now().toString(36)}${ext}`;
}

/** Örnek 3×1×3 cobble platform (test / demo) */
function ensureSampleSchematic() {
  const idx = readIndex();
  if (idx.items.some((i) => i.id === "sample-platform" || i.name === "Örnek Platform")) return;

  const blocks: SchematicBlock[] = [];
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      blocks.push({ dx, dy: 0, dz, name: "cobblestone" });
    }
  }
  // 2 blok yüksek mini kule köşede
  blocks.push({ dx: 0, dy: 1, dz: 0, name: "cobblestone" });
  blocks.push({ dx: 0, dy: 2, dz: 0, name: "cobblestone" });

  const payload = {
    name: "Örnek Platform",
    note: "3×3 cobble + 2 blok kule — test şeması",
    blocks
  };
  const filename = "sample-platform.caya.json";
  const filePath = path.join(SCHEMATICS_FILES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
  const st = fs.statSync(filePath);
  const meta: SchematicMeta = {
    id: "sample-platform",
    name: "Örnek Platform",
    filename,
    format: "caya-json",
    sizeBytes: st.size,
    width: 3,
    height: 3,
    length: 3,
    blockCount: blocks.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    note: payload.note
  };
  idx.items.unshift(meta);
  writeIndex(idx);
}

ensureSampleSchematic();

export function listSchematics(): SchematicMeta[] {
  ensureSampleSchematic();
  return readIndex().items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSchematicMeta(id: string): SchematicMeta | undefined {
  return readIndex().items.find((i) => i.id === id);
}

export function deleteSchematic(id: string): boolean {
  const idx = readIndex();
  const item = idx.items.find((i) => i.id === id);
  if (!item) return false;
  if (item.id === "sample-platform") {
    throw new Error("Örnek şema silinemez — kopya oluşturun veya kendi şemanızı yükleyin");
  }
  idx.items = idx.items.filter((i) => i.id !== id);
  writeIndex(idx);
  const fp = path.join(SCHEMATICS_FILES_DIR, item.filename);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    /* ignore */
  }
  return true;
}

export function addSchematicFromBase64(opts: {
  name: string;
  filename?: string;
  dataBase64: string;
  note?: string;
}): SchematicMeta {
  const name = opts.name.trim() || "Şema";
  const buf = Buffer.from(opts.dataBase64, "base64");
  if (buf.length < 4) throw new Error("Dosya çok küçük veya base64 geçersiz");
  if (buf.length > 25 * 1024 * 1024) throw new Error("Şema en fazla 25 MB olabilir");

  const lower = (opts.filename ?? name).toLowerCase();
  let format: SchematicFormat;
  let ext: string;
  if (lower.endsWith(".caya.json") || lower.endsWith(".json")) {
    format = "caya-json";
    ext = ".caya.json";
    // validate json early
    JSON.parse(buf.toString("utf8"));
  } else if (lower.endsWith(".schem") || lower.endsWith(".schematic") || buf[0] === 0x0a) {
    format = "schem";
    ext = ".schem";
  } else {
    // try json first
    try {
      JSON.parse(buf.toString("utf8"));
      format = "caya-json";
      ext = ".caya.json";
    } catch {
      format = "schem";
      ext = ".schem";
    }
  }

  const filename = safeFilename(opts.filename?.replace(/\.[^.]+$/, "") || name, ext);
  const filePath = path.join(SCHEMATICS_FILES_DIR, filename);
  fs.writeFileSync(filePath, buf);

  const id = newId();
  const now = Date.now();
  const meta: SchematicMeta = {
    id,
    name,
    filename,
    format,
    sizeBytes: buf.length,
    createdAt: now,
    updatedAt: now,
    note: opts.note
  };

  // parse once for dimensions
  try {
    const parsed = parseSchematicFile(meta);
    meta.width = parsed.width;
    meta.height = parsed.height;
    meta.length = parsed.length;
    meta.blockCount = parsed.blocks.length;
  } catch (e) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* */
    }
    throw new Error(`Şema okunamadı: ${e instanceof Error ? e.message : String(e)}`);
  }

  const idx = readIndex();
  idx.items.push(meta);
  writeIndex(idx);
  return meta;
}

export function addCayaJsonSchematic(opts: {
  name: string;
  blocks: SchematicBlock[];
  note?: string;
}): SchematicMeta {
  if (!opts.blocks?.length) throw new Error("En az bir blok gerekli");
  const body = JSON.stringify(
    { name: opts.name, note: opts.note, blocks: opts.blocks },
    null,
    2
  );
  return addSchematicFromBase64({
    name: opts.name,
    filename: `${opts.name}.caya.json`,
    dataBase64: Buffer.from(body, "utf8").toString("base64"),
    note: opts.note
  });
}

export function materialCounts(blocks: SchematicBlock[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const b of blocks) {
    if (!b.name || b.name === "air" || b.name === "cave_air" || b.name === "void_air") continue;
    m[b.name] = (m[b.name] ?? 0) + 1;
  }
  return m;
}

export function parseSchematicFile(meta: SchematicMeta, versionHint = "1.20.4"): ParsedSchematic {
  const filePath = path.join(SCHEMATICS_FILES_DIR, meta.filename);
  if (!fs.existsSync(filePath)) throw new Error(`Şema dosyası yok: ${meta.filename}`);

  if (meta.format === "caya-json") {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      blocks?: SchematicBlock[];
      name?: string;
    };
    const blocks = (raw.blocks ?? []).filter((b) => b && b.name && b.name !== "air");
    let minX = 0,
      minY = 0,
      minZ = 0,
      maxX = 0,
      maxY = 0,
      maxZ = 0;
    for (const b of blocks) {
      minX = Math.min(minX, b.dx);
      minY = Math.min(minY, b.dy);
      minZ = Math.min(minZ, b.dz);
      maxX = Math.max(maxX, b.dx);
      maxY = Math.max(maxY, b.dy);
      maxZ = Math.max(maxZ, b.dz);
    }
    // normalize to 0-based if needed
    const norm = blocks.map((b) => ({
      ...b,
      dx: b.dx - minX,
      dy: b.dy - minY,
      dz: b.dz - minZ
    }));
    return {
      meta,
      blocks: norm,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      length: maxZ - minZ + 1
    };
  }

  // WorldEdit .schem via prismarine-schematic
  // dynamic import-friendly require for CJS
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Schematic } = require("prismarine-schematic") as {
    Schematic: {
      read: (buf: Buffer, version?: string) => Promise<{
        start: () => { x: number; y: number; z: number };
        end: () => { x: number; y: number; z: number };
        forEach: (cb: (pos: { x: number; y: number; z: number }, block: { name: string }) => void) => void;
        getBlock: (pos: { x: number; y: number; z: number }) => { name: string };
      }>;
    };
  };

  // Schematic.read is async — we sync-wrap via deasync-less approach: callers use loadParsed async
  throw new Error("INTERNAL: use loadParsedSchematic for .schem");
}

/** Async load — .schem needs await Schematic.read */
export async function loadParsedSchematic(id: string, versionHint = "1.20.4"): Promise<ParsedSchematic> {
  const meta = getSchematicMeta(id);
  if (!meta) throw new Error("Şema bulunamadı");

  if (meta.format === "caya-json") {
    return parseSchematicFile(meta, versionHint);
  }

  const filePath = path.join(SCHEMATICS_FILES_DIR, meta.filename);
  const buf = fs.readFileSync(filePath);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Schematic } = require("prismarine-schematic") as {
    Schematic: {
      read: (b: Buffer, v?: string) => Promise<{
        start: () => { x: number; y: number; z: number };
        end: () => { x: number; y: number; z: number };
        forEach: (cb: (block: { name?: string }, pos: { x: number; y: number; z: number }) => void | Promise<void>) => Promise<void>;
      }>;
    };
  };
  let schematic: Awaited<ReturnType<typeof Schematic.read>>;
  try {
    schematic = await Schematic.read(buf, versionHint);
  } catch {
    schematic = await Schematic.read(buf);
  }

  const start = schematic.start();
  const end = schematic.end();
  const width = end.x - start.x + 1;
  const height = end.y - start.y + 1;
  const length = end.z - start.z + 1;

  const blocks: SchematicBlock[] = [];
  // prismarine-schematic: forEach(cb(block, pos)) — async
  await schematic.forEach((block, pos) => {
    const name = String(block?.name ?? "air").replace(/^minecraft:/, "");
    if (!name || name === "air" || name === "cave_air" || name === "void_air") return;
    blocks.push({
      dx: pos.x - start.x,
      dy: pos.y - start.y,
      dz: pos.z - start.z,
      name
    });
  });

  // update cache dims
  const idx = readIndex();
  const m = idx.items.find((i) => i.id === id);
  if (m) {
    m.width = width;
    m.height = height;
    m.length = length;
    m.blockCount = blocks.length;
    m.updatedAt = Date.now();
    writeIndex(idx);
  }

  return { meta: { ...meta, width, height, length, blockCount: blocks.length }, blocks, width, height, length };
}

export function filePathFor(meta: SchematicMeta): string {
  return path.join(SCHEMATICS_FILES_DIR, meta.filename);
}

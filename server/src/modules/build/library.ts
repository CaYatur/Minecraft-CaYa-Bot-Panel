import * as fs from "fs";
import * as path from "path";
import { SCHEMATICS_DIR, SCHEMATICS_FILES_DIR } from "../../config/paths";
import { newId } from "../../types";
import { looksLikeLitematic, parseLitematicBuffer, MAX_LITEMATIC_BLOCKS } from "./litematic";
import { assertSchematicId, resolveSchematicFile } from "./pathSafe";
import type { ParsedSchematic, SchematicBlock, SchematicFormat, SchematicMeta } from "./types";
import { applyTransform, normalizeRotateY, type BuildTransform } from "./transform";

const INDEX_PATH = path.join(SCHEMATICS_DIR, "index.json");
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BLOCKS = MAX_LITEMATIC_BLOCKS;

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
  const base =
    name
      .replace(/[^a-zA-Z0-9_\-\u00C0-\u024F]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 64) || "schema";
  return `${base}_${Date.now().toString(36)}${ext}`;
}

/** Örnek 3×1×3 cobble platform (test / demo) */
function ensureSampleSchematic() {
  const idx = readIndex();
  if (idx.items.some((i) => i.id === "sample-platform" || i.name === "Sample Platform")) return;

  const blocks: SchematicBlock[] = [];
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      blocks.push({ dx, dy: 0, dz, name: "cobblestone" });
    }
  }
  blocks.push({ dx: 0, dy: 1, dz: 0, name: "cobblestone" });
  blocks.push({ dx: 0, dy: 2, dz: 0, name: "cobblestone" });

  const payload = {
    name: "Sample Platform",
    note: "3×3 cobble + 2-block tower — test schematic",
    blocks
  };
  const filename = "sample-platform.caya.json";
  const filePath = resolveSchematicFile(filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
  const st = fs.statSync(filePath);
  const meta: SchematicMeta = {
    id: "sample-platform",
    name: "Sample Platform",
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
  const safe = assertSchematicId(id);
  return readIndex().items.find((i) => i.id === safe);
}

export function deleteSchematic(id: string): boolean {
  const safe = assertSchematicId(id);
  const idx = readIndex();
  const item = idx.items.find((i) => i.id === safe);
  if (!item) return false;
  if (item.id === "sample-platform") {
    throw new Error("Sample schematic cannot be deleted — make a copy or upload your own");
  }
  idx.items = idx.items.filter((i) => i.id !== safe);
  writeIndex(idx);
  try {
    const fp = resolveSchematicFile(item.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    /* ignore */
  }
  return true;
}

function detectFormat(buf: Buffer, filename?: string): { format: SchematicFormat; ext: string } {
  const lower = (filename ?? "").toLowerCase();
  if (lower.endsWith(".litematic") || looksLikeLitematic(buf, filename)) {
    // gzip litematic vs raw — still litematic if name says so; gzip schem also gzip
    if (lower.endsWith(".litematic")) return { format: "litematic", ext: ".litematic" };
  }
  if (lower.endsWith(".caya.json") || lower.endsWith(".json")) {
    return { format: "caya-json", ext: ".caya.json" };
  }
  if (lower.endsWith(".schem") || lower.endsWith(".schematic")) {
    return { format: "schem", ext: ".schem" };
  }
  // sniff
  try {
    JSON.parse(buf.toString("utf8"));
    return { format: "caya-json", ext: ".caya.json" };
  } catch {
    /* */
  }
  if (looksLikeLitematic(buf, filename) && lower.includes("lite")) {
    return { format: "litematic", ext: ".litematic" };
  }
  // gzip + unknown → try as schem first in load; for upload use schem unless name litematic
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    // default gzip schematic → schem; user should use .litematic extension for litematics
    return { format: "schem", ext: ".schem" };
  }
  return { format: "schem", ext: ".schem" };
}

export async function addSchematicFromBase64(opts: {
  name: string;
  filename?: string;
  dataBase64: string;
  note?: string;
}): Promise<SchematicMeta> {
  const name = opts.name.trim() || "Schematic";
  let buf: Buffer;
  try {
    buf = Buffer.from(opts.dataBase64, "base64");
  } catch {
    throw new Error("Could not decode base64");
  }
  if (buf.length < 4) throw new Error("File too small or invalid base64");
  if (buf.length > MAX_FILE_BYTES) throw new Error("Schematic max size is 25 MB");

  const lower = (opts.filename ?? name).toLowerCase();
  let { format, ext } = detectFormat(buf, opts.filename);
  if (lower.endsWith(".litematic")) {
    format = "litematic";
    ext = ".litematic";
  }

  if (format === "caya-json") {
    try {
      JSON.parse(buf.toString("utf8"));
    } catch {
      throw new Error("Invalid JSON schematic");
    }
  }

  const filename = safeFilename(path.basename(opts.filename ?? name).replace(/\.[^.]+$/, "") || name, ext);
  const filePath = resolveSchematicFile(filename);
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

  try {
    // temporarily register so load can find it
    const idx = readIndex();
    idx.items.push(meta);
    writeIndex(idx);
    const parsed = await loadParsedSchematic(id, "1.20.4");
    meta.width = parsed.width;
    meta.height = parsed.height;
    meta.length = parsed.length;
    meta.blockCount = parsed.blocks.length;
    if (parsed.meta.name && name === "Schematic") meta.name = parsed.meta.name;
    // update index entry
    const idx2 = readIndex();
    const m = idx2.items.find((i) => i.id === id);
    if (m) Object.assign(m, meta);
    writeIndex(idx2);
  } catch (e) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* */
    }
    const idx = readIndex();
    idx.items = idx.items.filter((i) => i.id !== id);
    writeIndex(idx);
    throw new Error(`Could not read schematic: ${e instanceof Error ? e.message : String(e)}`);
  }

  return meta;
}

export function addCayaJsonSchematic(opts: {
  name: string;
  blocks: SchematicBlock[];
  note?: string;
}): SchematicMeta {
  if (!opts.blocks?.length) throw new Error("En az bir blok required");
  if (opts.blocks.length > MAX_BLOCKS) throw new Error(`En fazla ${MAX_BLOCKS} blok`);
  const body = JSON.stringify({ name: opts.name, note: opts.note, blocks: opts.blocks }, null, 2);
  // sync path for simple json
  const name = opts.name.trim() || "Schematic";
  const filename = safeFilename(name, ".caya.json");
  const filePath = resolveSchematicFile(filename);
  const buf = Buffer.from(body, "utf8");
  fs.writeFileSync(filePath, buf);
  let minX = 0,
    minY = 0,
    minZ = 0,
    maxX = 0,
    maxY = 0,
    maxZ = 0;
  for (const b of opts.blocks) {
    minX = Math.min(minX, b.dx);
    minY = Math.min(minY, b.dy);
    minZ = Math.min(minZ, b.dz);
    maxX = Math.max(maxX, b.dx);
    maxY = Math.max(maxY, b.dy);
    maxZ = Math.max(maxZ, b.dz);
  }
  const meta: SchematicMeta = {
    id: newId(),
    name,
    filename,
    format: "caya-json",
    sizeBytes: buf.length,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    length: maxZ - minZ + 1,
    blockCount: opts.blocks.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    note: opts.note
  };
  const idx = readIndex();
  idx.items.push(meta);
  writeIndex(idx);
  return meta;
}

export function materialCounts(blocks: SchematicBlock[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const b of blocks) {
    if (!b.name || b.name === "air" || b.name === "cave_air" || b.name === "void_air") continue;
    m[b.name] = (m[b.name] ?? 0) + 1;
  }
  return m;
}

function parseCayaJson(meta: SchematicMeta): ParsedSchematic {
  const filePath = resolveSchematicFile(meta.filename);
  if (!fs.existsSync(filePath)) throw new Error(`Schematic file missing: ${meta.filename}`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { blocks?: SchematicBlock[] };
  const blocks = (raw.blocks ?? []).filter((b) => b && b.name && b.name !== "air");
  if (blocks.length > MAX_BLOCKS) throw new Error(`Block limit exceeded (${MAX_BLOCKS})`);
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

/** Async load — schem / litematic / caya-json */
export async function loadParsedSchematic(
  id: string,
  versionHint = "1.20.4",
  transform?: BuildTransform
): Promise<ParsedSchematic> {
  const meta = getSchematicMeta(id);
  if (!meta) throw new Error("Schematic not found");

  let base: ParsedSchematic;

  if (meta.format === "caya-json") {
    base = parseCayaJson(meta);
  } else if (meta.format === "litematic") {
    const filePath = resolveSchematicFile(meta.filename);
    const buf = fs.readFileSync(filePath);
    const lit = await parseLitematicBuffer(buf);
    base = {
      meta: {
        ...meta,
        width: lit.width,
        height: lit.height,
        length: lit.length,
        blockCount: lit.blocks.length,
        name: lit.name || meta.name
      },
      blocks: lit.blocks,
      width: lit.width,
      height: lit.height,
      length: lit.length
    };
  } else {
    // schem — if fails and gzip, try litematic as fallback
    const filePath = resolveSchematicFile(meta.filename);
    const buf = fs.readFileSync(filePath);
    try {
      base = await loadSchemBuffer(meta, buf, versionHint);
    } catch (schemErr) {
      try {
        const lit = await parseLitematicBuffer(buf);
        base = {
          meta: { ...meta, format: "litematic", width: lit.width, height: lit.height, length: lit.length, blockCount: lit.blocks.length },
          blocks: lit.blocks,
          width: lit.width,
          height: lit.height,
          length: lit.length
        };
        // promote format in index
        const idx = readIndex();
        const m = idx.items.find((i) => i.id === meta.id);
        if (m) {
          m.format = "litematic";
          writeIndex(idx);
        }
      } catch {
        throw schemErr;
      }
    }
  }

  if (transform && (transform.rotateY || transform.mirrorX || transform.mirrorZ)) {
    const t = applyTransform(base.blocks, {
      rotateY: normalizeRotateY(transform.rotateY),
      mirrorX: transform.mirrorX,
      mirrorZ: transform.mirrorZ
    });
    base = {
      ...base,
      blocks: t.blocks,
      width: t.width,
      height: t.height,
      length: t.length,
      meta: { ...base.meta, width: t.width, height: t.height, length: t.length, blockCount: t.blocks.length }
    };
  }

  // cache dims
  try {
    const idx = readIndex();
    const m = idx.items.find((i) => i.id === id);
    if (m && !transform) {
      m.width = base.width;
      m.height = base.height;
      m.length = base.length;
      m.blockCount = base.blocks.length;
      m.updatedAt = Date.now();
      writeIndex(idx);
    }
  } catch {
    /* */
  }

  return base;
}

async function loadSchemBuffer(meta: SchematicMeta, buf: Buffer, versionHint: string): Promise<ParsedSchematic> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Schematic } = require("prismarine-schematic") as {
    Schematic: {
      read: (
        b: Buffer,
        v?: string
      ) => Promise<{
        start: () => { x: number; y: number; z: number };
        end: () => { x: number; y: number; z: number };
        forEach: (
          cb: (block: { name?: string }, pos: { x: number; y: number; z: number }) => void | Promise<void>
        ) => Promise<void>;
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
  await schematic.forEach((block, pos) => {
    const name = String(block?.name ?? "air").replace(/^minecraft:/, "");
    if (!name || name === "air" || name === "cave_air" || name === "void_air") return;
    blocks.push({
      dx: pos.x - start.x,
      dy: pos.y - start.y,
      dz: pos.z - start.z,
      name
    });
    if (blocks.length > MAX_BLOCKS) throw new Error(`Block limit exceeded (${MAX_BLOCKS})`);
  });
  return { meta: { ...meta, width, height, length, blockCount: blocks.length }, blocks, width, height, length };
}

export function filePathFor(meta: SchematicMeta): string {
  return resolveSchematicFile(meta.filename);
}

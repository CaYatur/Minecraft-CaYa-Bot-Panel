// Generates build/icon.png (256x256) from the same pixel-art bot logo used in web/src/components/BotLogo.tsx.
// Pure Node, no image-library dependency — hand-rolls a minimal RGBA PNG encoder.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GRID = 16;
const SCALE = 16; // -> 256x256
const SIZE = GRID * SCALE;

const TRANSPARENT = [0, 0, 0, 0];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

// Same rects as BotLogo.tsx, painted in the same order (later overwrites earlier).
const RECTS = [
  { x: 7, y: 0, w: 2, h: 2, c: hex("#71717a") },
  { x: 7, y: 0, w: 2, h: 1, c: hex("#ef4444") },
  { x: 3, y: 3, w: 10, h: 11, c: hex("#27272a") },
  { x: 3, y: 3, w: 10, h: 1, c: hex("#52525b") },
  { x: 3, y: 3, w: 1, h: 11, c: hex("#3f3f46") },
  { x: 12, y: 3, w: 1, h: 11, c: hex("#18181b") },
  { x: 3, y: 13, w: 10, h: 1, c: hex("#18181b") },
  { x: 5, y: 6, w: 2, h: 2, c: hex("#10b981") },
  { x: 9, y: 6, w: 2, h: 2, c: hex("#10b981") },
  { x: 5, y: 10, w: 6, h: 1, c: hex("#52525b") }
];

const grid = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => TRANSPARENT));
for (const r of RECTS) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) grid[y][x] = r.c;
  }
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // no filter
  const gy = Math.floor(y / SCALE);
  for (let x = 0; x < SIZE; x++) {
    const gx = Math.floor(x / SCALE);
    const [r, g, b, a] = grid[gy][gx];
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = a;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0))
]);

const outDir = fileURLToPath(new URL("../build", import.meta.url));
mkdirSync(outDir, { recursive: true });
const outFile = dirname(outDir) + "/build/icon.png";
writeFileSync(outFile, png);
console.log("wrote", outFile, `${SIZE}x${SIZE}`);

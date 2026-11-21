import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as http from "http";
import { createRequire } from "module";

const nodeRequire = createRequire(__filename);

/**
 * prismarine-viewer 1.33 yalnızca y=0..255 arasındaki bölümleri çiziyor (addColumn döngüsü 0..256,
 * worker'da sections[y/16] kontrolü minY'yi bilmiyor). 1.18+ dünyalarında y<0 ve y>=256 boş kalıyor;
 * düz dünyada ya da yer altında tüm ekran mavi görünüyordu. Bu dosya o iki yeri düzeltilmiş
 * kopyalarla değiştirir: tarayıcı sayfası için public/index.js + worker.js, POV görüntüsü için Node worker'ı.
 */
export const VIEWER_MIN_Y = -64;
export const VIEWER_MAX_Y = 320;

const LOOP = /for\(let (\w)=0;\1<256;\1\+=16\)/g;
const SECTION_CHECK = /(\w+)\.sections\[Math\.floor\((\w+) ?\/ ?16\)\]/g;
// lib/index.js: kamera yalnızca pos.y > 0 iken yerleşiyor; y<=0'daki botta kamera (0,0,0)'da kalıp mavi ekran veriyordu
const CAMERA_GATE = /if\((\w)\.y>0&&(\w)&&\((\w)\.target\.set\(/g;
// models.js: y<0 komşusu "dünyanın dışı" sayılıp yüzey hiç çizilmiyor (tam bloklar görünmez oluyordu)
const BOTTOM_CULL = /(\w+)\.position\.y ?< ?0\) ?continue/g;

function viewerRoot(): string {
  return path.dirname(nodeRequire.resolve("prismarine-viewer/package.json"));
}

function cacheDir(): string {
  let stamp = "0";
  try {
    stamp = (nodeRequire("prismarine-viewer/package.json") as { version?: string }).version ?? "0";
  } catch { /* sürüm okunamadı */ }
  const dir = path.join(os.tmpdir(), `caya-pviewer-${stamp}-h${VIEWER_MIN_Y}-${VIEWER_MAX_Y}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Bölüm kontrolünü minY'ye göre kaydırır; beklenen sayıda eşleşme yoksa null (orijinal kullanılır). */
export function patchWorkerSource(source: string, expected = 2): string | null {
  const hits = source.match(SECTION_CHECK)?.length ?? 0;
  if (hits !== expected) return null;
  return source.replace(SECTION_CHECK, (_m, col: string, y: string) => `${col}.sections[Math.floor((${y}-(${col}.minY||0))/16)]`);
}

/** Yüzey kırpmadaki y<0 sınırını VIEWER_MIN_Y'ye indirir. */
export function patchModelsSource(source: string, expected = 2): string | null {
  const hits = source.match(BOTTOM_CULL)?.length ?? 0;
  if (hits !== expected) return null;
  return source.replace(BOTTOM_CULL, (_m, n: string) => `${n}.position.y<${VIEWER_MIN_Y})continue`);
}

/** addColumn/removeColumn döngülerini VIEWER_MIN_Y..VIEWER_MAX_Y aralığına genişletir, kamera kapısını açar. */
export function patchPageSource(source: string, expected = 2): string | null {
  const hits = source.match(LOOP)?.length ?? 0;
  const gates = source.match(CAMERA_GATE)?.length ?? 0;
  if (hits !== expected || gates !== 1) return null;
  return source
    .replace(LOOP, (_m, v: string) => `for(let ${v}=${VIEWER_MIN_Y};${v}<${VIEWER_MAX_Y};${v}+=16)`)
    // "henüz konum yok" (0,0,0) dışında her yükseklikte kamerayı bota yerleştir
    .replace(CAMERA_GATE, (_m, p: string, first: string, ctl: string) => `if((${p}.x!==0||${p}.y!==0||${p}.z!==0)&&${first}&&(${ctl}.target.set(`);
}

const pageCache = new Map<string, string | null>();

/** Tarayıcı sayfası dosyasının düzeltilmiş kopyasının yolu; düzeltilemiyorsa null. */
export function patchedPageFile(name: "index.js" | "worker.js"): string | null {
  if (pageCache.has(name)) return pageCache.get(name)!;
  let out: string | null = null;
  try {
    const target = path.join(cacheDir(), name);
    if (fs.existsSync(target)) out = target;
    else {
      const source = fs.readFileSync(path.join(viewerRoot(), "public", name), "utf8");
      const worker = name === "worker.js" ? patchWorkerSource(source) : null;
      const patched = name === "index.js" ? patchPageSource(source) : worker && patchModelsSource(worker);
      if (patched) {
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, patched);
        fs.renameSync(tmp, target);
        out = target;
      }
    }
  } catch {
    out = null;
  }
  pageCache.set(name, out);
  return out;
}

/** prismarine-viewer'ın express uygulamasının önüne geçer: /index.js ve /worker.js düzeltilmiş kopyadan gelir. */
export function wrapViewerHandler(handler: http.RequestListener): http.RequestListener {
  return (req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    const name = url.endsWith("/index.js") ? "index.js" : url.endsWith("/worker.js") ? "worker.js" : null;
    if (req.method === "GET" && name) {
      const file = patchedPageFile(name);
      if (file) {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
        fs.createReadStream(file).on("error", () => res.end()).pipe(res);
        return;
      }
    }
    handler(req, res);
  };
}

let nodeWorkerFile: string | null | undefined;

/** POV görüntüsü için Node worker'ının düzeltilmiş kopyası (göreli require'lar mutlak yola çevrilir). */
export function patchedNodeWorkerFile(): string | null {
  if (nodeWorkerFile !== undefined) return nodeWorkerFile;
  nodeWorkerFile = null;
  try {
    const lib = path.join(viewerRoot(), "viewer", "lib");
    const source = fs.readFileSync(path.join(lib, "worker.js"), "utf8");
    const patched = patchWorkerSource(source);
    const models = patchModelsSource(fs.readFileSync(path.join(lib, "models.js"), "utf8"));
    if (patched && models) {
      // dosyalar geçici dizinde çalışacak: require'ları orijinal yerlerinden çöz, models düzeltilmiş kopyadan
      const dir = cacheDir();
      const fromLib = createRequire(path.join(lib, "worker.js"));
      const absolute = (code: string, own: Record<string, string>) =>
        code.replace(/require\('([^']+)'\)/g, (_m, mod: string) => `require(${JSON.stringify(own[mod] ?? fromLib.resolve(mod))})`);
      const modelsFile = path.join(dir, "node-models.js");
      fs.writeFileSync(modelsFile, absolute(models, {}));
      const target = path.join(dir, "node-worker.js");
      fs.writeFileSync(target, absolute(patched, { "./models": modelsFile }));
      nodeWorkerFile = target;
    }
  } catch {
    nodeWorkerFile = null;
  }
  return nodeWorkerFile;
}

type NodeWorker = { onmessage?: unknown; on?(event: string, fn: (data: unknown) => void): void; terminate(): Promise<number> };
type RendererLike = {
  workers: NodeWorker[];
  loadedChunks: Record<string, boolean>;
  setSectionDirty(pos: unknown, value?: boolean): void;
  addColumn(x: number, z: number, chunk: unknown): void;
};

/**
 * Headless WorldRenderer'ı yükseklik düzeltmeli hale getirir: worker'lar düzeltilmiş dosyayla
 * yeniden açılır, addColumn tüm 1.18+ yüksekliğini kirletir. Başarısız olursa hiçbir şey değişmez.
 */
export function patchHeadlessRenderer(world: RendererLike): boolean {
  const file = patchedNodeWorkerFile();
  if (!file || !Array.isArray(world.workers) || world.workers.length === 0) return false;
  try {
    const { Worker } = nodeRequire("worker_threads") as typeof import("worker_threads");
    const { Vec3 } = nodeRequire("vec3") as typeof import("vec3");
    const fresh = world.workers.map((old) => {
      const worker = new Worker(file) as unknown as NodeWorker & { onmessage: (e: { data: unknown }) => void };
      worker.onmessage = old.onmessage as (e: { data: unknown }) => void;
      worker.on?.("message", (data) => worker.onmessage({ data }));
      // worker çökerse süreç düşmesin; görüntü zaman aşımıyla yine döner
      worker.on?.("error", () => undefined);
      void old.terminate().catch(() => 0);
      return worker;
    });
    world.workers.splice(0, world.workers.length, ...fresh);
    world.addColumn = function (this: RendererLike, x: number, z: number, chunk: unknown) {
      this.loadedChunks[`${x},${z}`] = true;
      for (const worker of this.workers) (worker as unknown as { postMessage(m: unknown): void }).postMessage({ type: "chunk", x, z, chunk });
      for (let y = VIEWER_MIN_Y; y < VIEWER_MAX_Y; y += 16) {
        const loc = new Vec3(x, y, z);
        this.setSectionDirty(loc);
        this.setSectionDirty(loc.offset(-16, 0, 0));
        this.setSectionDirty(loc.offset(16, 0, 0));
        this.setSectionDirty(loc.offset(0, 0, -16));
        this.setSectionDirty(loc.offset(0, 0, 16));
      }
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * A node-canvas surface whose getContext("webgl") is headless-gl.
 * prismarine-viewer and three.js draw into it, then toBuffer() reads the pixels back.
 * The panel depends on `canvas` and `gl` directly so a user does not install them.
 */
import { createRequire } from "module";
import { EventEmitter } from "events";

const require = createRequire(__filename);
const { Canvas, Image } = require("canvas") as {
  Canvas: new (width: number, height: number) => HeadlessSurface;
  Image: new () => unknown;
};
const createGLContext = require("gl") as (width: number, height: number, options?: Record<string, unknown>) => WebGLContext;

interface WebGLContext {
  canvas: unknown;
  RGBA: number;
  UNSIGNED_BYTE: number;
  readPixels(x: number, y: number, w: number, h: number, format: number, type: number, pixels: Uint8Array): void;
  getExtension(name: string): { resize(width: number, height: number): void } | null;
  getUniformLocation(program: unknown, name: string): unknown;
  texImage2D(...args: unknown[]): unknown;
  destroy?: () => void;
}

const ctxKey = Symbol("ctx");

export interface HeadlessSurface {
  width: number;
  height: number;
  style: Record<string, string>;
  __gl__?: WebGLContext;
  getContext(type: string, options?: Record<string, unknown>): unknown;
  toBuffer(mime: "image/png"): Buffer;
  createPNGStream(): NodeJS.ReadableStream;
  addEventListener(type: string, listener: (...args: unknown[]) => void): void;
  removeEventListener(type: string, listener?: (...args: unknown[]) => void): void;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | number | undefined;
  get clientWidth(): number;
  get clientHeight(): number;
}

class HeadlessCanvas extends (Canvas as new (width: number, height: number) => HeadlessSurface) {
  style: Record<string, string> = {};
  __gl__?: WebGLContext;
  private __contextType__?: string;
  private __event__ = new EventEmitter();
  private __attributes__: Record<string, string> = {};
  private [ctxKey]?: { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }; putImageData(data: unknown, x: number, y: number): void };

  override get width(): number {
    return super.width;
  }

  override set width(value: number) {
    this.__gl__?.getExtension("STACKGL_resize_drawingbuffer")?.resize(value, this.height);
    super.width = value;
  }

  override get height(): number {
    return super.height;
  }

  override set height(value: number) {
    this.__gl__?.getExtension("STACKGL_resize_drawingbuffer")?.resize(this.width, value);
    super.height = value;
  }

  override get clientWidth(): number {
    return this.width;
  }

  override get clientHeight(): number {
    return this.height;
  }

  override getContext(type: string, options?: Record<string, unknown>): unknown {
    if (this.__contextType__ && this.__contextType__ !== type) return null;
    if (this.__gl__) return this.__gl__;
    this.__contextType__ = type;
    if (type === "webgl" || type === "webgl2") {
      this[ctxKey] = super.getContext("2d") as HeadlessCanvas[typeof ctxKey];
      const gl = createGLContext(this.width, this.height, { preserveDrawingBuffer: true, ...options });
      const originalUniform = gl.getUniformLocation.bind(gl);
      gl.getUniformLocation = (program: { _uniforms?: { name: string }[] }, name: string) => {
        if (program?._uniforms && !/\[\d+\]$/.test(name)) {
          const reg = new RegExp(`${name}\\[\\d+\\]$`);
          for (const uniform of program._uniforms) {
            if (reg.test(uniform.name)) name = uniform.name;
          }
        }
        return originalUniform(program, name);
      };
      const originalTex = gl.texImage2D.bind(gl);
      gl.texImage2D = (...args: unknown[]) => {
        const last = args[args.length - 1] as { _image?: unknown } | undefined;
        if (last && last._image) args[args.length - 1] = last._image;
        if (last instanceof Image) {
          const image = last as { width: number; height: number };
          const copy = new Canvas(image.width, image.height);
          (copy.getContext("2d") as { drawImage(img: unknown, x: number, y: number): void }).drawImage(image, 0, 0);
          args[args.length - 1] = copy;
        }
        return originalTex(...args);
      };
      gl.canvas = this;
      this.__gl__ = gl;
      return gl;
    }
    return super.getContext(type, options);
  }

  private copyGlPixels(): void {
    const gl = this.__gl__;
    const ctx2d = this[ctxKey];
    if (!gl || !ctx2d) return;
    const { width, height } = this;
    const data = ctx2d.getImageData(0, 0, width, height);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let y = 0; y < height; y++) {
      const row = height - y - 1;
      for (let x = 0; x < width; x++) {
        const src = 4 * (row * width + x);
        const dst = 4 * (y * width + x);
        data.data[dst] = pixels[src] ?? 0;
        data.data[dst + 1] = pixels[src + 1] ?? 0;
        data.data[dst + 2] = pixels[src + 2] ?? 0;
        data.data[dst + 3] = pixels[src + 3] ?? 0;
      }
    }
    ctx2d.putImageData(data, 0, 0);
  }

  override toBuffer(mime: "image/png"): Buffer {
    this.copyGlPixels();
    return super.toBuffer(mime);
  }

  override addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.__event__.addListener(type, listener);
  }

  override removeEventListener(type: string, listener?: (...args: unknown[]) => void): void {
    if (listener) this.__event__.removeListener(type, listener);
    else this.__event__.removeAllListeners(type);
  }

  override setAttribute(key: string, value: string): void {
    this.__attributes__[key] = value;
    if (key === "width") this.width = Number(value);
    if (key === "height") this.height = Number(value);
  }

  override getAttribute(key: string): string | number | undefined {
    if (key === "width") return this.width;
    if (key === "height") return this.height;
    return this.__attributes__[key];
  }
}

export function createHeadlessCanvas(width: number, height: number): HeadlessSurface {
  return new HeadlessCanvas(width, height);
}

/** A colored cube, used to prove the bundled WebGL path returns a real PNG. */
export function renderProbePng(): Buffer {
  const THREE = require("three") as {
    Scene: new () => { add(obj: unknown): void; background: unknown };
    Color: new (hex: number) => unknown;
    PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => { position: { set(x: number, y: number, z: number): void }; lookAt(x: number, y: number, z: number): void };
    WebGLRenderer: new (options: { canvas: HeadlessSurface; antialias: boolean }) => { setSize(w: number, h: number, updateStyle: boolean): void; render(scene: unknown, camera: unknown): void; dispose(): void };
    Mesh: new (geometry: unknown, material: unknown) => unknown;
    BoxGeometry: new (w: number, h: number, d: number) => unknown;
    MeshBasicMaterial: new (options: { color: number }) => unknown;
  };
  const canvas = createHeadlessCanvas(160, 120);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(160, 120, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  const camera = new THREE.PerspectiveCamera(70, 160 / 120, 0.1, 100);
  camera.position.set(2.2, 1.4, 2.6);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xc0392b })));
  renderer.render(scene, camera);
  const png = canvas.toBuffer("image/png");
  releaseRenderer(renderer, canvas);
  return png;
}

/** three.js dispose expects a browser animation frame. Headless has none. */
export function releaseRenderer(renderer: { dispose(): void } | undefined, canvas: HeadlessSurface | undefined): void {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, "window");
  const host = global as { window?: { requestAnimationFrame?: (cb: () => void) => number; cancelAnimationFrame?: (id: number) => void } };
  if (!host.window) {
    host.window = {
      requestAnimationFrame: (cb) => setTimeout(cb, 16) as unknown as number,
      cancelAnimationFrame: (id) => clearTimeout(id)
    };
  }
  try {
    renderer?.dispose();
  } catch {
    /* context already gone */
  } finally {
    if (!hadWindow) delete host.window;
  }
  try {
    canvas?.__gl__?.destroy?.();
  } catch {
    /* already destroyed */
  }
}

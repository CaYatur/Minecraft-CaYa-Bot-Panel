/** Şema kütüphanesi + inşaat runtime tipleri (Faz 14–16) */

export type SchematicFormat = "schem" | "caya-json" | "litematic";

export interface SchematicMeta {
  id: string;
  name: string;
  filename: string;
  format: SchematicFormat;
  /** ham dosya boyutu (byte) */
  sizeBytes: number;
  /** parse sonrası (cache) */
  width?: number;
  height?: number;
  length?: number;
  blockCount?: number;
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export interface SchematicBlock {
  /** şema köşesine göre göreli (dx, dy, dz) */
  dx: number;
  dy: number;
  dz: number;
  /** minecraft block name (air atlanır) */
  name: string;
  /** opsiyonel state (v1 yok sayılabilir) */
  properties?: Record<string, string | number | boolean>;
}

export interface ParsedSchematic {
  meta: SchematicMeta;
  blocks: SchematicBlock[];
  width: number;
  height: number;
  length: number;
}

export interface MaterialNeed {
  name: string;
  need: number;
  have: number;
  missing: number;
}

export type BuildOriginMode = "here" | "coords" | "player";

export interface BuildOrigin {
  mode: BuildOriginMode;
  x?: number;
  y?: number;
  z?: number;
  player?: string;
}

export type BuildPhase =
  | "idle"
  | "preparing"
  | "acquiring"
  | "building"
  | "cleanup"
  | "done"
  | "failed"
  | "cancelled";

/** İnşa sırası: yakında/envanterde olan önce; eksik en sonda */
export type BuildPlaceOrder = "nearby-first" | "layer-first";

export interface BuildPlacedBlock {
  name: string;
  x: number;
  y: number;
  z: number;
  status: "placed" | "skipped" | "failed";
  t: number;
}

export interface BuildRuntime {
  phase: BuildPhase;
  schematicId: string | null;
  schematicName: string | null;
  origin: { x: number; y: number; z: number } | null;
  placed: number;
  total: number;
  skipped: number;
  failed: number;
  scaffoldsPlaced: number;
  scaffoldsCleared: number;
  materials: MaterialNeed[];
  label: string;
  error?: string;
  startedAt: number | null;
  /** son yerleştirilen blok (UI animasyon) */
  lastBlock: BuildPlacedBlock | null;
  /** son N blok izi */
  recentBlocks: BuildPlacedBlock[];
  transform: {
    rotateY: 0 | 90 | 180 | 270;
    mirrorX: boolean;
    mirrorZ: boolean;
  };
  /** yerleştirme sırası tercihi */
  placeOrder?: BuildPlaceOrder;
  collectMissing?: boolean;
}

export function emptyBuildRuntime(): BuildRuntime {
  return {
    phase: "idle",
    schematicId: null,
    schematicName: null,
    origin: null,
    placed: 0,
    total: 0,
    skipped: 0,
    failed: 0,
    scaffoldsPlaced: 0,
    scaffoldsCleared: 0,
    materials: [],
    label: "",
    startedAt: null,
    lastBlock: null,
    recentBlocks: [],
    transform: { rotateY: 0, mirrorX: false, mirrorZ: false },
    placeOrder: "nearby-first",
    collectMissing: false
  };
}

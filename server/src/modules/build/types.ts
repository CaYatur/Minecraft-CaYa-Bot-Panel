/** Şema kütüphanesi + inşaat runtime tipleri (Faz 14) */

export type SchematicFormat = "schem" | "caya-json";

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

export type BuildPhase = "idle" | "preparing" | "building" | "cleanup" | "done" | "failed" | "cancelled";

export interface BuildRuntime {
  phase: BuildPhase;
  schematicId: string | null;
  schematicName: string | null;
  origin: { x: number; y: number; z: number } | null;
  placed: number;
  total: number;
  skipped: number;
  scaffoldsPlaced: number;
  scaffoldsCleared: number;
  materials: MaterialNeed[];
  label: string;
  error?: string;
  startedAt: number | null;
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
    scaffoldsPlaced: 0,
    scaffoldsCleared: 0,
    materials: [],
    label: "",
    startedAt: null
  };
}

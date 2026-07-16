/** Schematic library + build runtime types (Faz 14–17) */

export type SchematicFormat = "schem" | "caya-json" | "litematic";

export interface SchematicMeta {
  id: string;
  name: string;
  filename: string;
  format: SchematicFormat;
  /** raw file size (bytes) */
  sizeBytes: number;
  /** parse cache */
  width?: number;
  height?: number;
  length?: number;
  blockCount?: number;
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export interface SchematicBlock {
  /** relative to schematic corner (dx, dy, dz) */
  dx: number;
  dy: number;
  dz: number;
  /** minecraft block name (air is skipped) */
  name: string;
  /** optional block state (orientation is best-effort) */
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
  /** counted in indexed nearby containers (chest/barrel/shulker) */
  stored: number;
  /** effective missing = need - have - stored (0 in creative) */
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
  | "verifying"
  | "cleanup"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

/**
 * Placement strategy:
 * - printer: strict bottom-up layers, serpentine rows (3D printer; default)
 * - nearby-first: opportunistic nearest placeable block
 * ("layer-first" is a legacy alias of printer.)
 */
export type BuildPlaceOrder = "printer" | "nearby-first";

export interface BuildPlacedBlock {
  name: string;
  x: number;
  y: number;
  z: number;
  status: "placed" | "skipped" | "failed" | "repaired" | "fixed";
  t: number;
}

export interface BuildStorageInfo {
  /** indexed container count (this server/dimension) */
  containers: number;
  /** last nearby storage scan */
  lastScanAt: number | null;
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
  /** re-placed after damage (verify/repair sweeps) */
  repaired: number;
  /** wrong existing blocks broken and corrected */
  fixedWrong: number;
  scaffoldsPlaced: number;
  scaffoldsCleared: number;
  /** scaffolds we could NOT clean (honest report) */
  scaffoldsLeft: number;
  materials: MaterialNeed[];
  label: string;
  error?: string;
  startedAt: number | null;
  /** last placed block (UI animation) */
  lastBlock: BuildPlacedBlock | null;
  /** last N block trace */
  recentBlocks: BuildPlacedBlock[];
  transform: {
    rotateY: 0 | 90 | 180 | 270;
    mirrorX: boolean;
    mirrorZ: boolean;
  };
  /** placement strategy */
  placeOrder?: BuildPlaceOrder;
  collectMissing?: boolean;
  /** creative mode: material needs auto-cancelled */
  creative?: boolean;
  /** watchdog note when progress stalls (null = healthy) */
  stuck?: string | null;
  /** a disconnected build will auto-resume on spawn */
  resumePending?: boolean;
  storage?: BuildStorageInfo;
  /** live activity: "Collecting: oak_log · 3/16" / "Craft: …" */
  activity?: string | null;
  /** material currently being worked on */
  activityMaterial?: string | null;
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
    repaired: 0,
    fixedWrong: 0,
    scaffoldsPlaced: 0,
    scaffoldsCleared: 0,
    scaffoldsLeft: 0,
    materials: [],
    label: "",
    startedAt: null,
    lastBlock: null,
    recentBlocks: [],
    transform: { rotateY: 0, mirrorX: false, mirrorZ: false },
    placeOrder: "printer",
    collectMissing: false,
    creative: false,
    stuck: null,
    resumePending: false,
    storage: { containers: 0, lastScanAt: null },
    activity: null,
    activityMaterial: null
  };
}

/** Normalize user/API input ("layer-first" legacy → printer). */
export function normalizePlaceOrder(v: unknown): BuildPlaceOrder {
  const s = String(v ?? "").trim();
  if (s === "nearby-first" || s === "nearby") return "nearby-first";
  return "printer";
}

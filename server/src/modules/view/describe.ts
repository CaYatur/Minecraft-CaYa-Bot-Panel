export interface ScenePoint {
  name: string;
  x: number;
  y: number;
  z: number;
  kind?: "block" | "mob" | "player" | "item";
  health?: number;
}

export interface SceneDescription {
  origin: { x: number; y: number; z: number };
  look: { yaw: number; pitch: number; fov: number };
  blocks: Array<{ name: string; nearest: { x: number; y: number; z: number }; distance: number; count: number }>;
  entities: Array<{ name: string; kind: string; x: number; y: number; z: number; distance: number; health?: number }>;
  crosshair: { type: "block" | "entity" | "none"; name?: string; distance?: number };
  light: number | null;
  time: number | null;
  weather: string | null;
}

export function lookVector(yaw: number, pitch: number): { x: number; y: number; z: number } {
  return {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch)
  };
}

export function inViewCone(
  origin: { x: number; y: number; z: number },
  yaw: number,
  pitch: number,
  fovDeg: number,
  point: { x: number; y: number; z: number }
): boolean {
  const look = lookVector(yaw, pitch);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dz = point.z - origin.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.05) return true;
  const dot = (dx / len) * look.x + (dy / len) * look.y + (dz / len) * look.z;
  const limit = Math.cos(((Math.min(140, Math.max(20, fovDeg)) / 2) * Math.PI) / 180);
  return dot >= limit - 1e-6;
}

export function describeScene(input: {
  origin: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  fov: number;
  blocks: ScenePoint[];
  entities: ScenePoint[];
  crosshair?: { type: "block" | "entity" | "none"; name?: string; distance?: number };
  light?: number | null;
  time?: number | null;
  weather?: string | null;
}): SceneDescription {
  const visibleBlocks = input.blocks.filter((point) => inViewCone(input.origin, input.yaw, input.pitch, input.fov, point));
  const grouped = new Map<string, { nearest: ScenePoint; distance: number; count: number }>();
  for (const point of visibleBlocks) {
    const distance = Math.hypot(point.x - input.origin.x, point.y - input.origin.y, point.z - input.origin.z);
    const cur = grouped.get(point.name);
    if (!cur) grouped.set(point.name, { nearest: point, distance, count: 1 });
    else {
      cur.count += 1;
      if (distance < cur.distance) {
        cur.distance = distance;
        cur.nearest = point;
      }
    }
  }
  const blocks = [...grouped.entries()]
    .map(([name, row]) => ({
      name,
      nearest: { x: row.nearest.x, y: row.nearest.y, z: row.nearest.z },
      distance: round(row.distance),
      count: row.count
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 40);
  const entities = input.entities
    .filter((point) => inViewCone(input.origin, input.yaw, input.pitch, input.fov, point))
    .map((point) => ({
      name: point.name,
      kind: point.kind ?? "mob",
      x: point.x,
      y: point.y,
      z: point.z,
      distance: round(Math.hypot(point.x - input.origin.x, point.y - input.origin.y, point.z - input.origin.z)),
      health: point.health
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 16);
  return {
    origin: input.origin,
    look: { yaw: input.yaw, pitch: input.pitch, fov: input.fov },
    blocks,
    entities,
    crosshair: input.crosshair ?? { type: "none" },
    light: input.light ?? null,
    time: input.time ?? null,
    weather: input.weather ?? null
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

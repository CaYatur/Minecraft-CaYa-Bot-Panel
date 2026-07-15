import type { Vec3 as Vec3Type } from "vec3";

/** CJS vec3 — hem default function hem { Vec3 } export eder */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Vec3Ctor = require("vec3") as unknown as new (x: number, y: number, z: number) => Vec3Type;

export function v3(x: number, y: number, z: number): Vec3Type {
  return new Vec3Ctor(x, y, z);
}

export { Vec3Ctor as Vec3 };

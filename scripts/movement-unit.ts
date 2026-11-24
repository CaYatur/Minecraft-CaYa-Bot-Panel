/**
 * Pure movement and MLG decisions. No Minecraft server.
 * These numbers are the current fall, parkour, door, and look rules.
 */
import { isWoodenOpenableBlock } from "../server/src/modules/movement/doors";
import { PlayerTrail } from "../server/src/modules/movement/trail";
import { entityLookPoint } from "../server/src/modules/movement/look";
import { Vec3 } from "vec3";
import {
  findGapLanding,
  isLongSprintGap,
  parkourFromMovement,
  pruneObservedJumps,
  pushObservedJump,
  type ObservedJump
} from "../server/src/modules/movement/parkour";
import { fallDamageHp } from "../server/src/modules/survival/fallGuard";
import { foodScore, isFood, isRawMeat } from "../server/src/modules/survival/foods";
import type { MovementConfig } from "../server/src/types";

let failures = 0;
const ok = (name: string) => console.log(`  ok ${name}`);
const fail = (name: string, detail?: string) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};
const assert = (name: string, cond: boolean, detail?: string) => (cond ? ok(name) : fail(name, detail));

const move = (patch: Partial<MovementConfig> = {}): MovementConfig =>
  ({
    allowParkour: true,
    parkourMaxGap: 3,
    ladderParkour: true,
    parkourSprint: true,
    ...patch
  }) as MovementConfig;

/** A bot standing in a world of solid blocks given as "x,y,z" keys. */
function fakeBot(solid: string[], at: [number, number, number]) {
  const set = new Set(solid);
  return {
    health: 20,
    entity: { position: new Vec3(at[0], at[1], at[2]) },
    blockAt: (p: { x: number; y: number; z: number }) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return set.has(k) ? { name: "stone", boundingBox: "block" } : { name: "air", boundingBox: "empty" };
    }
  } as unknown as Parameters<typeof findGapLanding>[0];
}
const row = (x0: number, x1: number, y: number, z: number) => {
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) out.push(`${x},${y},${z}`);
  return out;
};

function main() {
  console.log("— movement unit —\n");


  // gap landings (issue #34)
  {
    const pad = row(0, 4, 99, 0);
    const down2 = fakeBot([...pad, ...row(8, 11, 97, 0)], [4.5, 100, 0.5]);
    const l = findGapLanding(down2, { x: 10.5, y: 98, z: 0.5 }, 4);
    assert("3-gap down 2 lands on the first cell past the gap, not a farther one", l?.x === 8 && l?.gap === 3, JSON.stringify(l));
    const diag = fakeBot([...pad, ...row(7, 10, 99, 1)], [4.5, 100, 0.5]);
    const d = findGapLanding(diag, { x: 9.5, y: 100, z: 1.5 }, 4);
    assert("a pad one block to the side is found (diagonal jump)", d !== null && d.z === 1 && d.x >= 7, JSON.stringify(d));
    const hop = fakeBot([...pad, ...row(6, 9, 96, 0)], [4.5, 100, 0.5]);
    const h = findGapLanding(hop, { x: 8.5, y: 97, z: 0.5 }, 4);
    assert("a 1-block gap with a 3-block drop is a hop onto the first cell", h?.x === 6 && h?.y === 97 && h?.gap === 1, JSON.stringify(h));
    const walk = fakeBot([...pad, ...row(6, 9, 99, 0)], [4.5, 100, 0.5]);
    assert("a 1-block gap at the same height is left to walking", findGapLanding(walk, { x: 8.5, y: 100, z: 0.5 }, 4) === null);
    const far = fakeBot([...pad, ...row(10, 13, 99, 0)], [4.5, 100, 0.5]);
    assert("a 5-gap is not offered with max gap 4", findGapLanding(far, { x: 12.5, y: 100, z: 0.5 }, 4) === null);
    const corner = fakeBot([...pad, ...row(9, 12, 99, 4)], [4.5, 100, 0.5]);
    assert(
      "a same-level corner jump longer than 4 is never offered, even to the jump-to-player check (max 10)",
      findGapLanding(corner, { x: 10.5, y: 100, z: 4.5 }, 10) === null
    );
  }

  assert("fall of 3 blocks is safe", fallDamageHp(3) === 0);
  assert("fall of 4 blocks is 1 HP", fallDamageHp(4) === 1);
  assert("fall of 10 blocks is 7 HP", fallDamageHp(10) === 7);
  assert("water landing cancels fall damage", fallDamageHp(20, 0, 0, -1, 0) === 0);
  assert("a half-absorbed landing keeps half the damage", fallDamageHp(10, 0, 0, -1, 0.5) === 3);
  assert("feather falling IV cuts a 10-block fall", fallDamageHp(10, 4) === 3);
  assert("feather falling and protection stack under the armor cap", fallDamageHp(10, 4, 4) === 2);
  assert("armor reduction never exceeds 80 percent", fallDamageHp(10, 4, 20) === 1);
  assert("resistance V cancels fall damage", fallDamageHp(10, 0, 0, 4) === 0);

  assert("a 4-block gap is a sprint jump", isLongSprintGap({ y: 64, gap: 4 }, 64));
  assert("a 3-block gap with a 2-block drop is a sprint jump", isLongSprintGap({ y: 62, gap: 3 }, 64));
  assert("a 2-block gap with a 4-block drop is a sprint jump", isLongSprintGap({ y: 60, gap: 2 }, 64));
  assert("a 2-block same-level gap stays on pathfinder", !isLongSprintGap({ y: 64, gap: 2 }, 64));
  assert("a short drop of one block is not a sprint jump", !isLongSprintGap({ y: 63, gap: 3 }, 64));

  const defaults = parkourFromMovement(move());
  assert("parkour defaults to a 3-block gap", defaults.enabled && defaults.maxGap === 3 && defaults.sprintJumps && defaults.ladderParkour);
  assert("parkour gap is clamped to 2..4", parkourFromMovement(move({ parkourMaxGap: 9 })).maxGap === 4 && parkourFromMovement(move({ parkourMaxGap: 1 })).maxGap === 2);
  assert("parkour can be turned off", parkourFromMovement(move({ allowParkour: false })).enabled === false);

  const jumps: ObservedJump[] = [];
  pushObservedJump(jumps, { x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 });
  assert("a step shorter than 1.7 blocks is not a remembered jump", jumps.length === 0);
  pushObservedJump(jumps, { x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 0 });
  assert("a 4-block jump is remembered", jumps.length === 1);
  for (let i = 0; i < 12; i++) pushObservedJump(jumps, { x: i, y: 64, z: 0 }, { x: i + 4, y: 64, z: 0 });
  assert("only the last 8 jumps are kept", jumps.length === 8);
  jumps[0]!.at = Date.now() - 60_000;
  const kept = jumps.length - 1;
  pruneObservedJumps(jumps, 45_000);
  assert("only jumps older than 45 seconds are forgotten", jumps.length === kept);

  assert("wooden doors can be opened", isWoodenOpenableBlock({ name: "oak_door" }));
  assert("fence gates can be opened", isWoodenOpenableBlock({ name: "oak_fence_gate" }));
  assert("wooden trapdoors can be opened", isWoodenOpenableBlock({ name: "oak_trapdoor" }));
  assert("iron doors are not opened by hand", !isWoodenOpenableBlock({ name: "iron_door" }));
  assert("iron trapdoors are not opened by hand", !isWoodenOpenableBlock({ name: "iron_trapdoor" }));
  assert("solid blocks are not doors", !isWoodenOpenableBlock({ name: "stone" }));
  assert("a missing block is not a door", !isWoodenOpenableBlock(null));

  const look = entityLookPoint({ position: { x: 10, y: 64, z: -3 }, height: 1.8 } as never);
  assert("look aims at 85 percent of entity height", look.x === 10 && look.z === -3 && Math.abs(look.y - (64 + 1.8 * 0.85)) < 0.001);
  const defaultLook = entityLookPoint({ position: { x: 0, y: 70, z: 0 } } as never);
  assert("a missing height still aims at eye level", Math.abs(defaultLook.y - (70 + 1.8 * 0.85)) < 0.001);

  assert("steak outranks bread", foodScore("cooked_beef") > foodScore("bread") && foodScore("cooked_beef") > 0);
  assert("unknown items are not food", !isFood("dirt") && foodScore("dirt") === 0);
  assert("raw beef is raw meat", isRawMeat("beef") && !isRawMeat("cooked_beef"));
  assert("a potato is raw food", isFood("potato") && isRawMeat("potato"));
  assert("a pie name still counts as food", isFood("pumpkin_pie") && foodScore("pumpkin_pie") === 0);

  const trail = new PlayerTrail(5);
  trail.record({ x: 0, y: 64, z: 0 }, true);
  trail.record({ x: 0.5, y: 64, z: 0 }, true);
  assert("trail keeps one point per ~1.2 blocks", trail.size === 1);
  trail.record({ x: 2, y: 64, z: 0 }, false);
  assert("trail skips points in the air", trail.size === 1);
  trail.record({ x: 2, y: 64, z: 0 }, true);
  trail.recordJump({ x: 3, y: 64, z: 0 }, { x: 8, y: 64, z: 0 });
  const takeoff = trail.get(trail.end - 2);
  assert("a gap jump marks its takeoff with the landing", Boolean(takeoff?.jumpTo) && takeoff!.jumpTo!.x === 8);
  assert("the walk stops at a takeoff", trail.nextIndex(trail.start, 50) === trail.end - 2);
  assert("a takeoff leads to the jump, not a walk", trail.nextIndex(trail.end - 2) === trail.end - 2);
  for (let x = 9; x < 20; x += 1.5) trail.record({ x, y: 64, z: 0 }, true);
  assert("old points drop past the cap but indices stay absolute", trail.size === 5 && trail.start > 0 && trail.get(trail.start) !== undefined);
  assert("nearest point to the bot comes first", trail.get(trail.nearestIndices({ x: 19, y: 64, z: 0 }, 5)[0])!.x > 17);
  trail.record({ x: 60, y: 64, z: 0 }, true);
  assert("a teleport starts a new trail", trail.size === 1 && trail.get(trail.start)!.x === 60);
  console.log(failures ? `\nFAILED ${failures}` : "\nmovement unit passed");
  process.exit(failures ? 1 : 0);
}

main();

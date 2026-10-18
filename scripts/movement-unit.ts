/**
 * Pure movement and MLG decisions. No Minecraft server.
 * These numbers are the current fall, parkour, door, and look rules.
 */
import { isWoodenOpenableBlock } from "../server/src/modules/movement/doors";
import { entityLookPoint } from "../server/src/modules/movement/look";
import {
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

function main() {
  console.log("— movement unit —\n");

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

  console.log(failures ? `\nFAILED ${failures}` : "\nmovement unit passed");
  process.exit(failures ? 1 : 0);
}

main();

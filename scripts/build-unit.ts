/**
 * Pure build decisions. No Minecraft server and no compiled dist.
 * These are the current skip, facing, scaffold, and schematic rules.
 */
import * as path from "path";
import { isBedHead, isUpperHalf, shouldSkipBlock } from "../server/src/modules/build/blocks";
import {
  facesLikeStairs,
  facesTowardPlayer,
  isAirLike,
  isGravityBlock,
  isLiquid,
  isReplaceableBlock,
  isUnbreakable,
  namesMatch,
  oppositeFacing,
  yawForFacing
} from "../server/src/modules/build/maneuver";
import { assertSchematicId, resolveSchematicFile } from "../server/src/modules/build/pathSafe";
import { isScaffoldFamily } from "../server/src/modules/build/tools";
import { applyTransform, normalizeRotateY } from "../server/src/modules/build/transform";
import { itemNameForBlock } from "../server/src/modules/build/place";
import { pickBestWeaponName, weaponScore } from "../server/src/modules/combat/weapons";

let failures = 0;
const ok = (name: string) => console.log(`  ok ${name}`);
const fail = (name: string, detail?: string) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};
const assert = (name: string, cond: boolean, detail?: string) => (cond ? ok(name) : fail(name, detail));

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function main() {
  console.log("— build rules —\n");

  assert("air is not placed", shouldSkipBlock("air") === "not placeable");
  assert("a namespaced barrier is not placed", shouldSkipBlock("minecraft:barrier") === "not placeable");
  assert("stone is placed", shouldSkipBlock("stone") === null);
  assert("an upper door half is skipped", shouldSkipBlock("oak_door", { half: "upper" }) === "upper half (comes with bottom)");
  assert("a lower door half is placed", isUpperHalf("oak_door", { half: "lower" }) === false);
  assert("a bed head is skipped", isBedHead("red_bed", { part: "head" }) && shouldSkipBlock("red_bed", { part: "head" }) === "bed head (comes with foot)");
  assert("a bed foot is placed", !isBedHead("red_bed", { part: "foot" }));

  assert("short grass can be overwritten", isReplaceableBlock("minecraft:short_grass"));
  assert("dirt cannot be overwritten", !isReplaceableBlock("dirt"));
  assert("water is a liquid", isLiquid("flowing_water") && isAirLike("cave_air") && !isAirLike("water"));
  assert("bedrock is unbreakable", isUnbreakable("bedrock") && isUnbreakable("minecraft:end_portal_frame"));
  assert("stone can be broken", !isUnbreakable("stone"));
  assert("sand and concrete powder fall", isGravityBlock("sand") && isGravityBlock("white_concrete_powder") && isGravityBlock("powder_snow"));
  assert("dirt does not fall", !isGravityBlock("dirt"));
  assert("block suffix still matches the item", namesMatch("minecraft:dirt_block", "dirt"));

  assert("south facing looks along +Z", yawForFacing("south") === 0);
  assert("east facing looks along +X", yawForFacing("east") === -Math.PI / 2);
  assert("up is not a yaw", yawForFacing("up") === null);
  assert("opposite of north is south", oppositeFacing("north") === "south" && oppositeFacing("east") === "west");
  assert("stairs copy the player facing", facesLikeStairs("oak_stairs") && !facesLikeStairs("furnace"));
  assert("a furnace faces the player", facesTowardPlayer("minecraft:furnace") && facesTowardPlayer("observer"));
  assert("stairs do not face the player", !facesTowardPlayer("oak_stairs"));

  assert("water is placed from a bucket", itemNameForBlock("water").join() === "water_bucket");
  assert("redstone wire uses redstone dust", itemNameForBlock("redstone_wire").join() === "redstone");
  assert("carrots use carrot items", itemNameForBlock("minecraft:carrots").join() === "carrot");
  assert("a wall torch uses the standing torch", itemNameForBlock("oak_wall_torch").join() === "oak_torch");
  assert("dirt places as dirt", itemNameForBlock("dirt").join() === "dirt");

  assert("dirt is scaffold", isScaffoldFamily("minecraft:dirt") && isScaffoldFamily("scaffolding"));
  assert("a sword is not scaffold", !isScaffoldFamily("diamond_sword"));

  const turned = applyTransform(
    [
      { dx: 0, dy: 0, dz: 0, name: "stone" },
      { dx: 1, dy: 0, dz: 0, name: "oak_stairs", properties: { facing: "north" } }
    ],
    { rotateY: 90 }
  );
  const stair = turned.blocks.find((b) => b.name === "oak_stairs");
  assert("a 90 degree turn keeps both blocks", turned.blocks.length === 2 && turned.width === 1 && turned.length === 2 && turned.height === 1);
  assert("stairs move onto the Z axis and face east", stair?.dx === 0 && stair.dz === 1 && stair.properties?.facing === "east");

  const mirrored = applyTransform([{ dx: 1, dy: 2, dz: 0, name: "chest", properties: { facing: "east" } }], { mirrorX: true });
  const chest = mirrored.blocks[0];
  assert("mirror X flips the chest to face west", chest?.dx === 0 && chest.dy === 0 && chest.properties?.facing === "west");
  assert("an empty schematic stays empty", applyTransform([]).blocks.length === 0 && applyTransform([]).width === 0);
  assert("only quarter turns are kept", normalizeRotateY(450) === 90 && normalizeRotateY(-90) === 270 && normalizeRotateY(45) === 0);

  assert("a schematic id is kept", assertSchematicId("sample-platform") === "sample-platform");
  assert("a path in a schematic id is rejected", throws(() => assertSchematicId("../secret")));
  assert("an empty schematic id is rejected", throws(() => assertSchematicId("  ")));
  assert("a very long schematic id is rejected", throws(() => assertSchematicId("a".repeat(81))));
  const resolved = resolveSchematicFile("nested/house.schem");
  assert("a schematic file name cannot leave its folder", path.basename(resolved) === "house.schem" && !resolved.includes(`${path.sep}nested${path.sep}`));
  assert("a parent schematic name is rejected", throws(() => resolveSchematicFile("..")));

  assert("a diamond sword outranks an iron axe", weaponScore("diamond_sword") > weaponScore("iron_axe"));
  assert("the best weapon ignores a banned sword", pickBestWeaponName(["diamond_sword", "iron_pickaxe", "dirt"], ["diamond_sword"]) === "iron_pickaxe");
  assert("no weapon means a bare hand", pickBestWeaponName(["dirt", "bread"], []) === null);

  console.log(failures ? `\nFAILED ${failures}` : "\nbuild rules passed");
  process.exit(failures ? 1 : 0);
}

main();

/**
 * Parkour island baked into the flying-squid world before anyone joins.
 * Superflat grass stays around spawn. This box is cleared to air, including
 * bedrock, so the bot cannot walk around the jumps.
 *
 * Along +X at z=64, platforms are 5 blocks wide (z 62..66):
 *   start deck   x 58..66   top 14  (feet 15)
 *   3-block gap  x 67..69
 *   high deck    x 70..78   top 14
 *   stairs       x 79..85   one block down to top 7
 *   low deck     x 86..90   top 7   (feet 8)
 *   3-block gap  x 91..93   (same chunk as the low deck, so the landing is loaded)
 *   drop deck    x 94..101  top 4   (feet 5)
 *   ladder       x 102 z=64, facing west (collision on the east wall), up to the high deck
 *   high deck    x 103..112 top 14  (feet 15) — ladder exit and the 4-gap near pad
 *   4-block gap  x 113..116         — default parkour must refuse this
 *   far pad      x 117..123 top 14
 *
 * MLG pit, off the walk line: pad top y=1 around x=71 z=72. The bot is
 * teleported into the air above it. test-server/mlg-physics.cjs places water
 * from a bucket and applies vanilla fall damage when the landing is dry.
 */
const Vec3 = require("vec3");
const Block = require("prismarine-block");

const COURSE = {
  start: { x: 62, y: 15, z: 64 },
  afterStairs: { x: 89, y: 8, z: 64 },
  afterDrop: { x: 96, y: 5, z: 64 },
  afterLadder: { x: 106, y: 15, z: 64 },
  gap4Near: { x: 110, y: 15, z: 64 },
  gap4Far: { x: 120, y: 15, z: 64 },
  mlgDrop: { x: 71, y: 18, z: 72 },
  mlgLand: { x: 71, y: 2, z: 72 }
};

function local(n) {
  return ((n % 16) + 16) % 16;
}

async function install(serv) {
  const world = serv.overworld;
  const registry = serv.registry;
  if (!world || !registry?.blocksByName?.stone || !registry.blocksByName.ladder) {
    setTimeout(() => install(serv), 50);
    return;
  }
  const stone = registry.blocksByName.stone.id;
  // Facing west puts the thin collision on the east edge, against the wall.
  // Facing east blocks the west entrance, so the bot cannot walk onto the ladder.
  const ladderWest = Block(registry).fromProperties(
    registry.blocksByName.ladder.id,
    { facing: "west", waterlogged: false },
    0
  ).stateId;
  const columns = new Map();
  const columnAt = async (x, z) => {
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const key = `${cx},${cz}`;
    if (!columns.has(key)) columns.set(key, await world.getColumn(cx, cz));
    return columns.get(key);
  };
  const set = async (x, y, z, id) => {
    const chunk = await columnAt(x, z);
    chunk.setBlockType(new Vec3(local(x), y, local(z)), id);
  };
  const setState = async (x, y, z, stateId) => {
    const chunk = await columnAt(x, z);
    chunk.setBlockStateId(new Vec3(local(x), y, local(z)), stateId);
  };
  const fill = async (x0, x1, top, id) => {
    for (let x = x0; x <= x1; x++) {
      for (let z = 62; z <= 66; z++) {
        for (let y = 0; y <= top; y++) await set(x, y, z, id);
      }
    }
  };

  for (let x = 50; x <= 128; x++) {
    for (let z = 40; z <= 80; z++) {
      for (let y = 0; y <= 24; y++) await set(x, y, z, 0);
    }
  }
  await fill(58, 66, 14, stone);
  await fill(70, 78, 14, stone);
  const stairTops = [13, 12, 11, 10, 9, 8, 7];
  for (let i = 0; i < stairTops.length; i++) await fill(79 + i, 79 + i, stairTops[i], stone);
  await fill(86, 90, 7, stone);
  await fill(94, 101, 4, stone);

  // One ladder column. A neighbor rung would be a turning ladder, which the
  // climb refuses. The wall is east of the ladder. The deck on top of the wall
  // is the only way up.
  for (let y = 0; y <= 4; y++) await set(102, y, 64, stone);
  for (let y = 5; y <= 14; y++) await setState(102, y, 64, ladderWest);
  for (let z = 62; z <= 66; z++) {
    for (let y = 0; y <= 14; y++) await set(103, y, z, stone);
  }
  await fill(104, 112, 14, stone);
  // Dry floor under the 4-gap so a missed jump lands and takes fall damage.
  for (let x = 113; x <= 116; x++) {
    for (let z = 62; z <= 66; z++) await set(x, 0, z, stone);
  }
  await fill(117, 123, 14, stone);

  for (let x = 68; x <= 74; x++) {
    for (let z = 69; z <= 75; z++) {
      await set(x, 0, z, stone);
      await set(x, 1, z, stone);
    }
  }
  serv.info?.("[parkour] course ready: ladder x=102, 4-gap x=113..116, mlg pit 71,72");
}

module.exports.COURSE = COURSE;
module.exports.server = function (serv) {
  const run = () => install(serv).catch((err) => serv.err?.(err && err.stack ? err.stack : String(err)));
  if (serv.pluginsReady) run();
  else serv.once("pluginsReady", run);
};

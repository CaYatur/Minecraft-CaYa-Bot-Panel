/**
 * Parkour island baked into the flying-squid world before anyone joins.
 * Superflat grass stays around spawn. This box is cleared to air, including
 * bedrock, so the bot cannot walk around the jumps.
 *
 * Along +X at z=64, platforms are 5 blocks wide (z 62..66):
 *   start deck  x 58..66  top 14  (feet 15)
 *   3-block gap x 67..69
 *   high deck   x 70..78  top 14
 *   one-block stairs x 79..85 down to top 7
 *   low deck    x 86..90  top 7   (feet 8)
 *   3-block gap x 91..93  (same chunk as the low deck, so the landing is loaded)
 *   drop deck   x 94..101 top 4   (feet 5, three blocks below the low deck)
 */
const Vec3 = require("vec3");

const COURSE = {
  start: { x: 62, y: 15, z: 64 },
  afterStairs: { x: 89, y: 8, z: 64 },
  afterDrop: { x: 96, y: 5, z: 64 }
};

function local(n) {
  return ((n % 16) + 16) % 16;
}

async function install(serv) {
  const world = serv.overworld;
  const registry = serv.registry;
  if (!world || !registry?.blocksByName?.stone) {
    setTimeout(() => install(serv), 50);
    return;
  }
  const stone = registry.blocksByName.stone.id;
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
  const fill = async (x0, x1, top, id) => {
    for (let x = x0; x <= x1; x++) {
      for (let z = 62; z <= 66; z++) {
        for (let y = 0; y <= top; y++) await set(x, y, z, id);
      }
    }
  };

  for (let x = 50; x <= 110; x++) {
    for (let z = 50; z <= 78; z++) {
      for (let y = 0; y <= 22; y++) await set(x, y, z, 0);
    }
  }
  await fill(58, 66, 14, stone);
  await fill(70, 78, 14, stone);
  const stairTops = [13, 12, 11, 10, 9, 8, 7];
  for (let i = 0; i < stairTops.length; i++) await fill(79 + i, 79 + i, stairTops[i], stone);
  await fill(86, 90, 7, stone);
  await fill(94, 101, 4, stone);
  serv.info?.("[parkour] course ready at x=58..101 z=64");
}

module.exports.COURSE = COURSE;
module.exports.server = function (serv) {
  const run = () => install(serv).catch((err) => serv.err?.(err && err.stack ? err.stack : String(err)));
  if (serv.pluginsReady) run();
  else serv.once("pluginsReady", run);
};

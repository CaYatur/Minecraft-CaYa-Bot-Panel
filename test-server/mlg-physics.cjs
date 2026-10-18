/**
 * The bits of vanilla this test server otherwise skips, only enough for the
 * parkour MLG leg to be real:
 * - use_item with a water bucket places a source on the first solid below
 *   the player (within reach) and swaps the bucket to empty.
 * - landing after a fall of more than 3 blocks deals floor(fall)−3 health,
 *   unless the feet are already in water.
 *
 * flying-squid 1.16 listens to block_place, and mineflayer pours a bucket
 * with use_item. Without this plugin the pour is ignored and falls never hurt,
 * so a missed MLG would still look healthy.
 */
const Vec3 = require("vec3");

function feetInWater(player, registry, pos) {
  const water = registry.blocksByName.water.id;
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const z = Math.floor(pos.z);
  const checks = [];
  for (const dx of [0, 1, -1]) {
    for (const dz of [0, 1, -1]) {
      for (const dy of [0, 1, -1]) {
        checks.push(player.world.getBlockType(new Vec3(x + dx, y + dy, z + dz)).then((id) => id === water));
      }
    }
  }
  return Promise.all(checks).then((hits) => hits.some(Boolean)).catch(() => false);
}

async function placeWaterBelow(player, serv) {
  const registry = serv.registry;
  const heldSlot = 36 + player.heldItemSlot;
  const held = player.inventory.slots[heldSlot];
  const waterItem = registry.itemsByName.water_bucket;
  const emptyItem = registry.itemsByName.bucket;
  const water = registry.blocksByName.water;
  if (!held || !waterItem || held.type !== waterItem.id || !water) return;

  const pos = player.position;
  const x = Math.floor(pos.x);
  const z = Math.floor(pos.z);
  const feet = Math.floor(pos.y);
  let solidY = null;
  for (let y = feet; y >= feet - 5 && y >= 0; y--) {
    let id = 0;
    try {
      id = await player.world.getBlockType(new Vec3(x, y, z));
    } catch {
      id = 0;
    }
    const block = registry.blocks[id];
    if (block && block.boundingBox === "block" && block.name !== "ladder") {
      solidY = y;
      break;
    }
  }
  if (solidY == null) return;
  const placeY = solidY + 1;
  if (pos.y - placeY > 5.2) return;
  let above = 0;
  try {
    above = await player.world.getBlockType(new Vec3(x, placeY, z));
  } catch {
    above = 0;
  }
  if (above === water.id) return;
  const aboveBlock = registry.blocks[above];
  if (aboveBlock && aboveBlock.boundingBox === "block") return;

  const Item = require("prismarine-item")(registry);
  await serv.setBlock(player.world, new Vec3(x, placeY, z), water.defaultState);
  player.inventory.updateSlot(heldSlot, new Item(emptyItem.id, 1));
  serv.info?.(`[mlg] water at ${x},${placeY},${z}`);
}

module.exports.player = function (player, serv) {
  const registry = serv.registry;
  if (!registry?.blocksByName?.water || !registry.itemsByName?.water_bucket) return;

  let peak = player.position?.y ?? 0;
  let airborne = false;

  player._client.on("use_item", () => {
    placeWaterBelow(player, serv).catch((err) => serv.err?.(err && err.stack ? err.stack : String(err)));
  });

  player.on("move", (data) => {
    if (!data?.position) return;
    if (data.teleport) {
      peak = data.position.y;
      airborne = false;
      return;
    }
    const y = data.position.y;
    const ground = Boolean(data.onGround);
    if (!ground) {
      airborne = true;
      if (y > peak) peak = y;
      if (peak - y > 3) {
        feetInWater(player, registry, data.position).then((wet) => {
          if (wet) peak = y;
        }).catch(() => {});
      }
      return;
    }
    if (!airborne) {
      peak = y;
      return;
    }
    const fall = peak - y;
    airborne = false;
    peak = y;
    if (fall <= 3 || player.gameMode !== 0 || typeof player.updateHealth !== "function") return;
    const dmg = Math.max(0, Math.floor(fall) - 3);
    if (dmg <= 0) return;
    feetInWater(player, registry, data.position).then((wet) => {
      if (wet || player.health <= 0) return;
      const next = Math.max(0, player.health - dmg);
      player.updateHealth(next);
      serv.info?.(`[mlg] fall ${fall.toFixed(1)} → ${dmg} dmg (health ${next})`);
    }).catch(() => {});
  });
};

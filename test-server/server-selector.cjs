/**
 * Issue #34 — lobi sunucularındaki "sunucu seçici" menüsünün küçük bir taklidi.
 * Elde pusula varken sağ tık (use_item) 3 satırlık sandık görünümlü bir menü açar:
 * slot 11 OneBlock, 13 Lifesteal, 15 Survival (özel adlı + açıklamalı eşyalar).
 * Menüdeki bir eşyaya tıklanınca gerçek sunucular gibi tıklamayı onaylar, menüyü
 * kapatır ve sohbete "[selector] joined <mod>" yazar. Panel testleri (scripts/gui-test.mjs)
 * bu satırı bekler. flying-squid bunların hiçbirini kendisi yapmaz.
 */
const OPTIONS = [
  { slot: 11, item: "grass_block", name: "OneBlock", color: "green" },
  { slot: 13, item: "red_dye", name: "Lifesteal", color: "red" },
  { slot: 15, item: "iron_pickaxe", name: "Survival", color: "aqua" }
];
const MENU_SLOTS = 27;
const MENU_TITLE = JSON.stringify({ text: "Server Selector", color: "dark_purple" });

function namedItem(registry, option) {
  const def = registry.itemsByName[option.item];
  if (!def) return { present: false };
  return {
    present: true,
    itemId: def.id,
    itemCount: 1,
    nbtData: {
      type: "compound",
      name: "",
      value: {
        display: {
          type: "compound",
          value: {
            Name: { type: "string", value: JSON.stringify({ text: option.name, color: option.color, italic: false }) },
            Lore: { type: "list", value: { type: "string", value: [JSON.stringify({ text: `Click to join ${option.name}`, color: "gray" })] } }
          }
        }
      }
    }
  };
}

module.exports.player = function (player, serv) {
  const registry = serv.registry;
  const compass = registry?.itemsByName?.compass;
  if (!compass) return;
  const Item = require("prismarine-item")(registry);
  let menuId = null;
  let nextId = 100;

  const openMenu = () => {
    menuId = nextId++;
    if (nextId > 120) nextId = 100;
    player._client.write("open_window", { windowId: menuId, inventoryType: 2, windowTitle: MENU_TITLE });
    const items = [];
    for (let i = 0; i < MENU_SLOTS; i++) {
      const option = OPTIONS.find((o) => o.slot === i);
      items.push(option ? namedItem(registry, option) : { present: false });
    }
    // alt kısım: oyuncunun ana envanteri (9-35) + hotbar (36-44)
    for (let i = 9; i <= 44; i++) items.push(Item.toNotch(player.inventory.slots[i] ?? null));
    player._client.write("window_items", { windowId: menuId, stateId: 1, items, carriedItem: { present: false } });
    serv.info?.(`[selector] menu ${menuId} opened for ${player.username}`);
  };

  player._client.on("use_item", () => {
    const held = player.inventory.slots[36 + player.heldItemSlot];
    if (held && held.type === compass.id) openMenu();
  });

  player._client.on("window_click", (click) => {
    if (menuId === null || click.windowId !== menuId) return;
    // 1.16: istemci "transaction" onayını bekler
    if (click.action !== undefined) {
      player._client.write("transaction", { windowId: click.windowId, action: click.action, accepted: true });
    }
    const option = OPTIONS.find((o) => o.slot === click.slot);
    if (!option) {
      // boş slot — gerçek menüler gibi hiçbir şey olmaz, menü açık kalır
      player._client.write("window_items", {
        windowId: menuId,
        stateId: 1,
        items: Array.from({ length: MENU_SLOTS }, (_, i) => {
          const o = OPTIONS.find((x) => x.slot === i);
          return o ? namedItem(registry, o) : { present: false };
        }),
        carriedItem: { present: false }
      });
      return;
    }
    const closed = menuId;
    menuId = null;
    player._client.write("set_slot", { windowId: -1, slot: -1, item: { present: false } });
    player._client.write("close_window", { windowId: closed });
    player.chat(`[selector] joined ${option.name}`);
    serv.info?.(`[selector] ${player.username} picked ${option.name} (button ${click.mouseButton}, mode ${click.mode})`);
  });

  player._client.on("close_window", (packet) => {
    if (packet.windowId === menuId) menuId = null;
  });
};

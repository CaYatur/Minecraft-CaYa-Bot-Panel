# Server menus, item use, and bulk actions

Added for [issue #34](https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/issues/34). None of these move the bot.

## Server menus (GUI windows)

Many lobby servers open a chest-style menu, a "server selector", when you right-click a compass, clock or nether star. The bot can now do the same:

1. **Inventory tab → Menus & item use → Use held item.** This right-clicks with the selected hotbar item. Selecting an inventory item and pressing **Use (right-click)** first moves it to the hand.
2. The open menu appears as a grid. Every slot shows the server's custom name (colour codes removed), and its tooltip shows the lore lines.
3. Click a slot to pick it. The click type (left, right or shift) is set above the grid. Most selectors take a left click; when the server accepts the pick, the menu closes or changes.
4. **Close menu** works like pressing Esc.

The menu updates live over Socket.IO (`bot:window`) when the server opens, changes or closes it.

### REST

| Call | Body | Result |
|---|---|---|
| `GET /api/bots/:id/window` | — | Window snapshot (`open`, `id`, `type`, `title`, `containerSlots`, `totalSlots`, `slots[]`) |
| `POST /api/bots/:id/gui` | `{ op: "use", hotbar?, item?, offhand?, holdMs?, waitWindowMs? }` | `{ result: { used, hotbar, openedWindow, window } }` |
| | `{ op: "hotbar", hotbar: 0-8 }` | `{ hotbar, held, window }` |
| | `{ op: "click", slot, button?, hotbar?, windowId?, waitMs? }` | `{ result: { clicked, changed: same \| new-window \| closed, window } }` |
| | `{ op: "close" }` | `{ closed, window }` |

`button` is one of `left` (the default), `right`, `shift`, `shift-right`, `middle`, `drop`, `drop-stack` or `number`. `number` swaps the slot with the hotbar slot given in `hotbar`. Pass `windowId` so a click never lands in a different menu than the one you read.

Slots `0 … containerSlots-1` are the menu itself. The rest are the player's own inventory rows inside that window.

Socket clients can send the same body as `bot:gui` with `{ botId, op, ... }`. When an ack callback is given, it receives `{ ok, result | error }`.

### MCP tools

| Tool | Category | What it does |
|---|---|---|
| `get_open_window` | info | Lists the open menu's title and slots, with custom names and lore |
| `use_held_item` | inventory | Right-clicks, optionally after picking a hotbar slot or an item by name or custom name. Waits for a menu and returns it |
| `select_hotbar_slot` | inventory | Selects hotbar slot 0-8 |
| `click_window_slot` | inventory | Clicks a slot and reports `same`, `new-window` or `closed` |
| `close_window` | inventory | Closes the menu |

A typical agent flow is `use_held_item {item:"compass"}`, then read the slots, then `click_window_slot {slot: 13}`, then `get_recent_chat`.

## Bulk actions for selected bots

On the Dashboard each bot card has a checkbox. The bar above the cards acts only on the selected bots:

- **Start, Stop, Stop work.** Start keeps the usual staggered connect.
- **Send.** Sends a chat line or `/command`. `{bot}` becomes each bot's name.
- **Use held item, Hotbar → Select, Menu slot → Click slot, Close menu.** These are the same GUI actions as above, so one click joins a game mode on every selected bot.

Each bot is tried on its own. The result lists every bot, and a failure on one bot does not stop the others.

`POST /api/bots/bulk-action` with `{ ids: [...], action: { type, ... } }` runs one action, and `GET /api/bots/bulk-action` lists the action types. The types are `start`, `stop`, `stop-work`, `chat` (`text`), `use-item` (`hotbar`, `item`), `hotbar` (`hotbar`), `click-slot` (`slot`, `button`), `close-window` and `task`. `task` takes any existing panel action object in `action` and is available from the panel API only. Up to 100 bots are allowed per call. `staggerMs` (0-5000) spaces the bots out; for chat, use-item and click-slot it defaults to 200 ms.

The MCP tool `bulk_action` takes `bots` (usernames or ids, or `["*"]` for every agent-enabled bot) and the same actions except `task`. It only touches bots with agent control enabled, and each action is checked against its own permission category: chat needs the chat category and the GUI actions need inventory. Slash commands follow the same utility-mode rule as `send_chat`.

## Test server

`test-server/server-selector.cjs` adds a small server selector to the flying-squid test server. Right-clicking a compass opens "Server Selector", with OneBlock in slot 11, Lifesteal in 13 and Survival in 15. Picking one closes the menu and writes `[selector] joined <mode>` in chat. `npm run test:gui` (part of `npm run test:all`) drives this through REST, the bulk endpoint and MCP.

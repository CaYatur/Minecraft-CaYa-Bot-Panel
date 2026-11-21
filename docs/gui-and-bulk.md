# Server menus, item use, bulk actions, and the command list

Added for [issue #34](https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/issues/34). None of these move the bot.

## Server command list

The **Chat** tab shows the commands the server told this bot it may use. The list comes from the `declare_commands` tree sent when the bot joins. A later tree, for example after a server switch, replaces the list entirely.

Each row is one command. Arguments stay on that row as `<player>` or `<message>`. Redirects are followed once, and the list stops at 8 words and 400 rows so a large tree stays readable. Clicking a row writes the command into the chat box. It is not sent until you press Send.

If the bot is offline, or the server has not sent a tree yet, the list is empty.

The MCP tool `server_commands` (info category, always on) returns the same lines. Pass `filter` for a case-insensitive substring and `limit` (1–200, default 80). It does not run a command. That is separate from `server_command`, which sends one slash command and stays behind utility mode.

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
| `server_commands` | info | Read-only command list from the server tree. Optional `filter` and `limit`. Does not send a command |
| `use_held_item` | inventory | Right-clicks, optionally after picking a hotbar slot or an item by name or custom name. Waits for a menu and returns it |
| `select_hotbar_slot` | inventory | Selects hotbar slot 0-8 |
| `click_window_slot` | inventory | Clicks a slot and reports `same`, `new-window` or `closed` |
| `close_window` | inventory | Closes the menu |

A typical agent flow is `use_held_item {item:"compass"}`, then read the slots, then `click_window_slot {slot: 13}` (or `click_window_slot {item: "Lifesteal"}`), then `get_recent_chat`.

`click_window_slot` (REST `POST /api/bots/:id/gui` with `op: "click"`, Socket.IO and MCP) takes either `slot` or `item`. `item` is matched against the menu items' custom name, display name and item id: an exact match wins, then a name that contains the text, then lore that contains it. Only the menu's own slots are searched, not the player inventory rows. If no menu is open yet, `waitWindowMs` (up to 15000) waits for one to open.

## Automation

The rule editor (simple and advanced) has a **Menu** action category. The actions reuse the same GUI code, so the hunter-mode lock and errors are the same as above.

| Action | Fields | What it does |
|---|---|---|
| `use_held_item` | `item` (optional, picks that hotbar item), `hotbar` (optional 0-8), `waitSeconds` (default 2) | Right-clicks the held item and waits for a menu. With `requireWindow: true` the rule fails if no menu opens |
| `select_hotbar_slot` | `slot` (0-8) | Switches the hotbar slot |
| `click_window_slot` | `item` (name or lore text) or `slot`, `button` (`left`, `right`, `shift`), `waitSeconds` (default 3) | Waits for a menu if none is open, then clicks the matching slot. The rule fails if nothing matches |
| `close_window` | none | Closes the open menu |

Text fields accept `{variables}`. The **Window opened** trigger (`window_opened`) fires once per new menu. Its `pattern` is matched as text contained in the title, case-insensitive, and the rule gets `{windowTitle}`, `{windowId}` and `{windowType}`.

The **Join game mode on spawn** blueprint (disabled when imported) runs on `bot_spawned`: wait 2 s, `use_held_item` with `compass`, then `click_window_slot` with `Survival`. Change the item and the mode name to match your server. `bot_spawned` also fires after a respawn or a server switch; if the bot has no compass there, the rule just fails and logs it.

MCP has no separate rule-editing tool. Create these rules with `template_import` and `apply: true`. Templates are checked against the action catalog, so the menu actions are accepted and unknown action types are refused.

## Bulk actions for selected bots

On the Dashboard each bot card has a checkbox. The bar above the cards acts only on the selected bots:

- **Start, Stop, Stop work.** Start keeps the usual staggered connect.
- **Send.** Sends a chat line or `/command`. `{bot}` becomes each bot's name.
- **Use held item, Hotbar → Select, Menu slot → Click slot, Close menu.** These are the same GUI actions as above, so one click joins a game mode on every selected bot.

Each bot is tried on its own. The result lists every bot, and a failure on one bot does not stop the others.

`POST /api/bots/bulk-action` with `{ ids: [...], action: { type, ... } }` runs one action, and `GET /api/bots/bulk-action` lists the action types. The types are `start`, `stop`, `stop-work`, `chat` (`text`), `use-item` (`hotbar`, `item`), `hotbar` (`hotbar`), `click-slot` (`slot`, `button`), `close-window` and `task`. `task` takes any existing panel action object in `action` and is available from the panel API only. Up to 100 bots are allowed per call. `staggerMs` (0-5000) spaces the bots out; for chat, use-item and click-slot it defaults to 200 ms.

The MCP tool `bulk_action` takes `bots` (usernames or ids, or `["*"]` for every agent-enabled bot) and the same actions except `task`. It only touches bots with agent control enabled, and each action is checked against its own permission category: chat needs the chat category and the GUI actions need inventory. Slash commands follow the same utility-mode rule as `send_chat`.

## Test server

`test-server/server-selector.cjs` adds a small server selector to the flying-squid test server. Right-clicking a compass opens "Server Selector", with OneBlock in slot 11, Lifesteal in 13 and Survival in 15. Picking one closes the menu and writes `[selector] joined <mode>` in chat. `npm run test:gui` (part of `npm run test:all`) drives this through REST, the bulk endpoint and MCP, and checks that a spawn automation imported over MCP uses the compass and joins OneBlock by item name.

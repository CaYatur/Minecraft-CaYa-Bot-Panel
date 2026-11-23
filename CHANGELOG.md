# Changelog

All notable changes to Minecraft CaYa Bot Panel. Dates are release dates.

## About the version numbers

The release after **1.0.4** is **3.0.5**. There was never a 2.x release and no 3.0.0–3.0.4.

The work that followed 1.0.4 (Microsoft accounts, 24/7 mode, Discord, automation templates, the bot view and the Windows installer) was first marked 1.0.5. That tag was withdrawn before it was published, and the batch was released as 3.0.5 instead, because it changed how the panel is used far more than a patch release would suggest (sign-in, stored secrets, a desktop installer). Nothing was skipped: every change between 1.0.4 and 3.0.5 is listed under 3.0.5 below. From 3.0.5 on, versions move one step at a time again.

## Unreleased

### Fixes
- **Bots can walk on 1.21.2+ servers with an anti-cheat.** A bot joining as 26.x (or 1.21.2+) could use items and place blocks but was pulled back on every step, so follow, goto and building never moved it. mineflayer never sent `tick_end`, sent `player_input` only for sneaking, sent a yaw that lagged the direction it walked, and on 1.21.6+ sent "start sprinting" with an old id that the server reads as "start riding jump". The panel now sends the input, rotation, sprint and tick packets the way the game client does. On a Paper + ViaVersion + GrimAC test server the bot went from hundreds of Grim flags and no movement to walking, following and jumping with none. Older versions keep mineflayer's packets. Set `CAYA_PROTOCOL_COMPAT=off` to turn this off. See [#34](https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/issues/34).
- **4-block gaps.** The sprint jump now takes off on the last tick the bot still stands on the edge, so a same-level 4-block gap is cleared instead of falling short. Goto tries a jump when there is no walking path (with Parkour max gap set to 4; the default is 3).
- **Leaving a ladder at the top.** A bot following a player who stood on the only block next to the top of a ladder kept climbing and sliding on the last rung. Goals no longer end while the bot hangs on a ladder, and no jump is planned from a ladder, so the bot steps off onto the block.

### Features
- **Server command list.** The Chat tab shows the commands the connected server sent for that bot, grouped by command, with search. Clicking a row fills the chat box and does not send it. The list is replaced whenever a new command tree arrives. Every top-level command keeps at least one line when the list is cut (2,000 lines), and copies such as `minecraft:give` are hidden when `give` exists. The read-only MCP tool `server_commands` returns the same list, with an optional filter. See [#34](https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/issues/34).

### Tests
- New `npm run test:protocol` (movement packet order, sprint ids, attributes, teleports) in `test:all`, and command-list cases in `test:platform`. `test-server/README.md` describes the Paper + ViaVersion + GrimAC check.

## 3.0.7 — 2026-11-21

Bug-fix and feature release for [#34](https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/issues/34).

### Fixes
- **3D view on newer Minecraft versions.** A bot that joins as 26.x (for example through ViaVersion) no longer shows "null is not supported" and a blank blue screen. The viewer only has textures up to 1.21.4, so the panel now uses those textures and shows a short note. Blocks are translated by name and properties. Blocks that 1.21.4 does not have are drawn as the closest older block, a full block with no match is drawn as stone, and anything else is skipped. Versions the viewer cannot show at all get a clear message.
- **3D view below y=0.** Blocks below y=0 and above y=255 are drawn, and the camera is placed for bots at any height, so flat worlds and underground bots no longer show an empty view.
- POV snapshots wait for all chunks to finish drawing before the frame is taken.

### Features
- **Use the held item and click menus.** A bot can right-click its held item (for example a lobby compass), read the menu that opens (titles, custom names and lore), click a slot (left, right, shift and more), switch hotbar slots and close the menu. Available in the Inventory tab, over REST and Socket.IO, and as MCP tools: `get_open_window`, `use_held_item`, `select_hotbar_slot`, `click_window_slot`, `close_window`.
- **Bulk actions on selected bots.** Every bot card on the Dashboard has a checkbox, and the "Actions for selected bots" bar runs start, stop, stop work, chat (`{bot}` becomes each bot's name), use held item, hotbar, menu slot click and close menu on all of them, with a result per bot. Also available as `POST /api/bots/bulk-action` and the `bulk_action` MCP tool.
- **Menu actions in automations.** Rules can use the held item, select a hotbar slot, click a menu slot and close the menu. A slot can be clicked by item name or lore text instead of a number, and the click waits for the menu to open. The REST, Socket.IO and MCP `click_window_slot` accept the same `item` and `waitWindowMs` options.
- **Window opened trigger** that fires when a menu whose title contains a given text opens, and a **Join game mode on spawn** blueprint (spawn, wait, use compass, click the mode by name). Rules with menu actions can be imported over MCP with `template_import`.

### Tests
- New `npm run test:gui` against a lobby "Server Selector" menu on the test server, including a spawn automation that joins a mode, plus 26.1 viewer tests in `npm run test:platform` and unit tests for the menu actions.

## 3.0.6 — 2026-10-18

Stabilization and bug-fix release.

### Security
- **Secrets are encrypted at rest.** Microsoft token caches, the Discord bot token and webhook URL, and login-plugin passwords are sealed with AES-256-GCM. The data key is kept by the desktop app's main process, protected by the OS keychain (Windows DPAPI through Electron `safeStorage`), and handed to the backend over the existing process channel.
- Microsoft sign-in uses an in-memory token cache that persists only the sealed form, so token JSON is no longer written to disk in clear text.
- Existing plaintext files (`*_live-cache.json`, `*_mca-cache.json`, `*_xbl-cache.json`, `discord-secrets.json`, `login-secrets.json`) are encrypted on first start and the plaintext copies are overwritten and deleted.
- When encryption is not available (plain `npm run dev`, or no OS keychain), the panel shows a warning banner instead of failing silently.
- The MCP bearer token is sealed the same way in `mcp-token.json.sealed` and no longer stored in `mcp.json`. An existing token is moved on first start (the old `mcp.json` is wiped and rewritten without it), so connected MCP clients keep working.
- The data folder is restricted to the current user (by SID) and SYSTEM on Windows. The ACL is set on the folder itself and inherited by everything inside, not applied file by file. It no longer skips this when `USERNAME` is empty.
- Recovery for files locked by the earlier per-file (`/T`) ACL run: on every start the panel first resets the ACLs inside the data folder to inherit from it (`icacls /reset /T`), taking ownership first if the reset is refused, and only then hardens the folder. Manual recovery, run as the same Windows user with the panel closed:

  ```bat
  icacls "%APPDATA%\caya-bot-panel\data" /reset /T /C /Q
  ```

  If that reports "Access is denied", take ownership first, then repeat the reset:

  ```bat
  takeown /F "%APPDATA%\caya-bot-panel\data" /R /D Y
  ```
- The REST API, Socket.IO and `/mcp` check the `Host` and `Origin` headers. Requests from other web pages (CSRF) and DNS-rebinding hosts are refused with 403. MCP clients and scripts that send no `Origin` keep working. Extra host names can be allowed with `CAYA_ALLOWED_HOSTS`.
- Discord webhook calls, including **Test webhook**, only go to `https://discord.com/api/webhooks/…` (or `discordapp.com`). Other URLs are rejected before any request and redirects are not followed.

### Fixes
- Login-plugin passwords are stored exactly as typed. Leading and trailing spaces are no longer trimmed.
- Closing the Microsoft sign-in dialog, or letting the device code expire, now moves the bot to **stopped** with a clear message instead of leaving it in an error or connecting state.
- The 3D bot view checks free memory first and limits how many views run at once (1–3, by CPU count). A second tab on the same bot reuses the running view instead of restarting it. The view closes when the bot disconnects or reconnects, instead of staying attached to the old connection.
- Web panel review: see the 3.0.6 UI notes in the pull request (states, validation, secret fields, translations, layout, accessibility).

### Packaging
- The Windows release ships only the **Setup (NSIS)** installer plus `SHA256SUMS.txt`. The portable exe is no longer built.
- `npm run test:packaging` checks the build config and that the viewer, Discord, canvas and headless GL modules are production dependencies, so they are copied into the installed app.

### Tests
- New `npm run test:security`: crypto round trip, tamper detection, migration of plaintext files, the encrypted token cache, untrimmed passwords, webhook URL rules, Host/Origin rules, the Windows ACL arguments and the viewer limits.

## 3.0.5 — 2026-10-18

- Microsoft (premium) device-code sign-in with several cached accounts.
- 24/7 mode: autostart with delay, reconnect after a drop, anti-AFK settings, login-plugin auto `/login` and `/register`, uptime statistics.
- Discord: webhook notices, a guild slash-command bot and a two-way chat bridge.
- Automation templates with bundled examples.
- Bot view: local 3D page and a first-person PNG for MCP.
- Windows installer (NSIS).
- Baseline, movement, build and platform test suites in CI.

## 1.0.4 — 2026-09-30

Movement, farming, gathering, MLG and protocol-update fixes.

## 1.0.0 – 1.0.3 — 2026-07 to 2026-08

First public releases.

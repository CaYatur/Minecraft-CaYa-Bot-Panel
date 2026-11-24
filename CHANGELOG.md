# Changelog

All notable changes to Minecraft CaYa Bot Panel. Dates are release dates.

## About the version numbers

The release after **1.0.4** is **3.0.5**. There was never a 2.x release and no 3.0.0–3.0.4.

The work that followed 1.0.4 (Microsoft accounts, 24/7 mode, Discord, automation templates, the bot view and the Windows installer) was first marked 1.0.5. That tag was withdrawn before it was published, and the batch was released as 3.0.5 instead, because it changed how the panel is used far more than a patch release would suggest (sign-in, stored secrets, a desktop installer). Nothing was skipped: every change between 1.0.4 and 3.0.5 is listed under 3.0.5 below. From 3.0.5 on, versions move one step at a time again.

## 3.0.8 — 2026-11-24

Bug-fix and feature release for [#34](https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/issues/34).

### Fixes
- **Bots can walk on 1.21.2+ servers with an anti-cheat.** A bot joining as 26.x (or 1.21.2+) could use items and place blocks but was pulled back on every step, so follow, goto and building never moved it. mineflayer never sent `tick_end`, sent `player_input` only for sneaking, sent a yaw that lagged the direction it walked, and on 1.21.6+ sent "start sprinting" with an old id that the server reads as "start riding jump". The panel now sends the input, rotation, sprint and tick packets the way the game client does. On a Paper + ViaVersion + GrimAC test server the bot went from hundreds of Grim flags and no movement to walking, following and jumping with none. Older versions keep mineflayer's packets. Set `CAYA_PROTOCOL_COMPAT=off` to turn this off. See [#34](https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/issues/34).
- **4-block gaps.** The sprint jump takes off on the last tick the bot still stands on the edge. Where that last tick falls depended on where the run started (0.01 to 0.25 blocks past the support edge), and from the near end a 4-block jump fell short about half the time. Before the run the bot now simulates it and, if needed, sneaks back a few hundredths of a block so it leaves from the far end. Once across it stops instead of running on. Goto and follow jump a 4-block gap when there is no walking path, also when the player is already across and off to the side (with Parkour max gap set to 4; the default is 3).
- **Following across 2–3 block gaps.** When the bot already stood on the edge, pathfinder would not jump without a run-up and the bot waited about 10 seconds. It now takes that jump with a run-up, and the follow goal is refreshed when the bot is idle short of a player who stopped: following a player who jumped a gap went from 12 s to under 2 s.
- **Finding the way to the player inside builds.** In a build with floors, beams and ladders, follow searched for 4 seconds, timed out every time, and parked the bot under the player. Searches now start with a small detour budget and widen only when nothing fits, so the search no longer floods the terrain below (the shortest route within the budget is still found). When no route is found, the bot walks the route the player took, in short legs, and copies the player's jumps. It no longer follows a best-effort path down into a place it cannot leave, and no 3+ block jump (or 2 up) is planned where there is no room for a run-up (for example sideways off a 1-wide beam); a standing 2-block jump from beam to beam still works.
- **Spiral ladders.** On ladders that wrap around a pillar (each rung on the next face, one block up), the bot let go between two rungs and fell, then tried the same thing again. Diagonal rung-to-rung moves are now planned, and the bot only pushes toward the next rung when a short physics look-ahead says it will catch it. On the reporter-style test world the spiral was climbed in one go in 18 of 18 runs, from near and far, with the player standing still or walking.
- **Leaving a ladder at the top.** A bot following a player who stood on the only block next to the top of a ladder kept climbing and sliding on the last rung. Goals no longer end while the bot hangs on a ladder, and no long jump is planned from a ladder, so the bot steps off onto the block (a 1-block hop from a ladder onto a wall top is still used).
- **Teleported bots.** After a `/tp` (or any server teleport) the bot kept walking the route it had planned from the old spot, and a jump planned there could send it off toward a block 9 blocks away. The route, the walk along the player's trail and the search are now re-planned from where the bot is, and the parkour helper only takes a jump pathfinder could have planned from here, never longer than Parkour max gap. A jump under way ends on a stop or a teleport.
- **Jumps are rehearsed before they are taken.** Before a jump the bot runs it in the physics engine: a jump under a low ceiling, or one that would fly past a 1x1 pillar or the end of a beam, is not attempted (the bot stays put instead of falling). Over a narrow or lower landing it lets go of forward and brakes in the air, onto a 1x1 pillar it uses a walking jump, and a 1-block gap with a drop is a short hop instead of a sprint jump that flew over the beam below. A jump pathfinder has already started is never cut into, and follow and goto re-plan only once the bot stands again (a re-plan let go of every key in mid-air and the jump fell short). Pathfinder no longer plans a 3-across, 1-up jump itself; the rehearsed jump takes it when it is the only way.
- **More jumps are found.** Landings one or two blocks to the side (diagonal and corner jumps) are found, a gap is measured to the first block past it (a 3-block gap was taken as a 4 to a farther block), and goto tries a jump toward the target before an unbounded search (that search could time out in a large build and the jump was never tried).
- **Swimming out of deep water.** Pathfinder never plans a jump out of water, so a pool two blocks deep with a ledge on the far side had no way across: the bot swam back to where it came in. It now swims up against the ledge and climbs out.
- **GrimAC setbacks.** After a server setback mineflayer marked the bot as airborne; with air speed its next step missed again and GrimAC set it back every tick for as long as it kept moving, so it stood at a jump lip. On 1.21.2+ the bot now keeps its ground state across a setback like the game does, stands up for a few ticks after sneaking before it sprints, restarts a run-up that was set back, and lets go of all keys for a moment when several setbacks come in a row. On the GrimAC test server 4-block, up and down gap jumps now pass with no flags.
- **Following a moving player across gaps.** When the player moved while the bot was in the air, pathfinder re-planned from the block behind the bot and turned it round mid-jump, so it fell short (on a test maze of floating platforms, following a leader bot failed 7 of 18 routes, against 2 for 3.0.7). The follow goal now waits until the bot stands again: 18 of 18 and 17 of 18 in two runs. The parkour helper also takes a jump on pathfinder's best guess only when it gets nearer the goal, never jumps back to a block the bot has already passed, and takes over a jump onto a narrow landing only from a standstill or at the end of the route (while running, pathfinder's own jump carries it on along pillars, strips and stairs; the braked run-up took about 5 seconds a jump). After braking on a landing it steps back onto the landing block.
- **Vines and cobwebs.** Pathfinder climbed ladders only; vines are now climbed the same way. A cobweb is no longer a wall: the bot wades through it when there is no other way.
- **Closed iron doors** were planned through like wooden doors, and the bot pushed against one forever. They are walls now (an open one is still walked through).
- **Magma.** Goto planned straight across magma blocks; the fire guard then pulled the bot off its route and the goto reported "completed" where the bot stood. Routes now go round magma when a short detour does, and goto only finishes at its own target (after the fire guard moves the bot, it carries on).
- **Building walks** use the same bounded search and do not step down into pits on a best-effort path.
- **Food watch** no longer queues a failing "get food" task every 15 seconds when there is nothing to hunt: the retry interval doubles up to 10 minutes and resets once the bot has food.
- **Smaller, faster install.** The installed app was 1.2 GB in about 44,000 files, which made Setup slow. Bedrock Edition data (never used by the panel) and the 3D viewer's build-time texture files are no longer shipped; the viewer still has its texture atlases, block states and mob textures.

### Features
- **Join newer servers through ViaProxy.** When a server runs a Minecraft version the bot library does not support yet (26.3 today), the panel starts [ViaProxy](https://github.com/ViaVersion/ViaProxy) on this computer and the bot joins through it, even if the server has no ViaBackwards. Each server profile has a ViaProxy setting: Auto (default), Always or Off. It needs Java 17 or newer, downloads ViaProxy once (~47 MB, checked against its published SHA-256), and checks for a newer ViaProxy every 12 hours, so new Minecraft versions work once ViaProxy supports them, without a new panel release. Offline-mode servers only: ViaProxy cannot sign in with a Microsoft account. `CAYA_VIAPROXY_AUTO_UPDATE=off` keeps the built-in 3.4.14.
- The Minecraft version notice now says that bots join newer servers through ViaProxy, instead of saying they cannot join.
- **Portable zip.** Besides the Setup exe, the release has a portable zip: unzip it once and run the exe inside, nothing is unpacked again on each start.
- **Server command list.** The Chat tab shows the commands the connected server sent for that bot, grouped by command, with search. Clicking a row fills the chat box and does not send it. The list is replaced whenever a new command tree arrives. Every top-level command keeps at least one line when the list is cut (2,000 lines), and copies such as `minecraft:give` are hidden when `give` exists. The read-only MCP tool `server_commands` returns the same list, with an optional filter. See [#34](https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/issues/34).

### Tests
- New `npm run test:protocol` (movement packet order, sprint ids, attributes, teleports and setbacks) in `test:all`, command-list cases in `test:platform`, and player-trail, gap-landing, mid-jump follow and iron-door cases in `test:movement`. `test-server/README.md` describes the Paper + ViaVersion + GrimAC check.

### Known limitations
- On a server with GrimAC, a few moves can still be set back in mid-air (no flags are raised) and fail: step-up jumps from 1x1 block to 1x1 block, a jump up from the wall beside a ladder top, and jumps between floating platforms (on the test maze of platforms, goto reached 10 of 18 and following a leader bot 5 of 15; walking, following and building on the ground are not affected). The spiral-ladder climb was tested on vanilla Paper only.
- Not attempted: neo jumps (around a wall), head-hitter jumps under a 2-block ceiling, spirals with one rung per side around a 2x2 core, and jumps onto fence or wall tops (pathfinder cannot stand on them). Climbing scaffolding and opening a closed trapdoor overhead are not supported either.

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

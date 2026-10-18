# Bot view

The panel has two ways to see what a bot sees:

- **3D view**: a live local page rendered by `prismarine-viewer`, opened from the bot page.
- **POV tools**: a text description (`bot_view_describe`) and a still PNG (`bot_view_screenshot`), for MCP clients and scripts.

## 3D view

The 3D view is **off by default**. Nothing listens until you press **Open view** on the **Bot view** tab of a bot that is online.

- It listens on `127.0.0.1` only, on a free port chosen at start. It is never reachable from other machines.
- The panel tab sends a heartbeat every few seconds. When no tab has sent one for about 20 seconds (tab closed, panel closed), the view stops and the port closes.
- `prismarine-viewer`, `canvas` and headless WebGL (`gl`) ship with the panel. If the viewer fails to load, or the Minecraft version is not supported, the panel shows the reason and does not keep a port open.

### Resource checks

Rendering runs on the CPU. Before a view starts the panel checks:

| Check | Limit | Message code |
|---|---|---|
| Free memory | at least 512 MB | `viewer.memory` |
| Views running at once | 1 per 2 CPU cores, at least 1, at most 3 | `viewer.limit` |

When a check fails the view does not start and the panel says why. The text description and PNG tools still work.

### Several tabs, several bots, reconnects

- Opening the view for the same bot in a second tab (or from MCP while a tab has it open) reuses the running view. It is not restarted, so the first tab keeps working.
- Each bot has at most one view. Views for different bots count against the limit above.
- Two quick clicks on **Open view** start only one view.
- A view belongs to one connection. When the bot disconnects, is kicked, stops or reconnects, the view closes. Open it again once the bot is back online.

## POV description and screenshot

`bot_view_describe` returns the blocks and entities inside the current look cone. It does not turn the bot's head unless `applyLook` is true. The same shape is available as `POST /api/bots/:id/view/describe`.

`bot_view_screenshot` and `POST /api/bots/:id/view/snapshot` render a first-person PNG, up to 1280×720. The image is what the bot is looking at. It does not move the bot. Width and height above the cap are reduced before render.

## MCP tools

| Tool | What it does |
|---|---|
| `bot_view_start` | Starts the local 3D page and returns its URL. Applies the same resource checks. |
| `bot_view_stop` | Stops the 3D page. |
| `bot_view_status` | Whether a view is running, and its URL. |
| `bot_view_describe` | Text description of the look cone. |
| `bot_view_screenshot` | First-person PNG. |

## Troubleshooting

- **"The built-in 3D viewer failed to load"**: the native `canvas` or `gl` module did not load. On a source checkout run `npm rebuild canvas gl`. In the installed app, reinstall with the latest Setup.
- **"This Minecraft version cannot be shown"**: the viewer does not support that protocol. Use the POV tools instead.
- **"Not enough free memory" / "Only N 3D views can run at once"**: close another bot view or free memory, then open it again.
- **Black or empty view right after joining**: chunks are still loading. Wait a few seconds.

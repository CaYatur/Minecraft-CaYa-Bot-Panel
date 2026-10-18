# Bot view

The 3D view is off until you open it on the bot page. It listens on `127.0.0.1` only while a panel tab sends a heartbeat. Closing the tab stops it after about 20 seconds. `prismarine-viewer`, `canvas`, and headless WebGL ship with the panel. If that bundled viewer fails to load, or the Minecraft version is not supported, the panel shows that message and does not keep a port open.

`bot_view_describe` returns the blocks and entities inside the current look cone. It does not turn the bot's head unless `applyLook` is true. The same shape is available as `POST /api/bots/:id/view/describe`.

`bot_view_screenshot` and `POST /api/bots/:id/view/snapshot` render a first-person PNG, up to 1280×720. The image is what the bot is looking at. It does not move the bot. Width and height above the cap are reduced before render.

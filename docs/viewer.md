# Bot view

The 3D view is off until you open it on the bot page. It listens on `127.0.0.1` only while a panel tab sends a heartbeat. Closing the tab stops it after about 20 seconds. If `prismarine-viewer` cannot load, or the Minecraft version is not supported, the panel shows that message and does not keep a port open.

`bot_view_describe` returns the blocks and entities inside the current look cone. It does not turn the bot's head unless `applyLook` is true. The same shape is available as `POST /api/bots/:id/view/describe`.

`bot_view_screenshot` asks for a PNG or JPEG up to 1280×720. Without `node-canvas-webgl` it returns `viewer.webgl_unavailable` and no image. A text description is the fallback for servers and CI that have no display. Do not send a screenshot larger than that cap; the extra pixels are dropped before render.

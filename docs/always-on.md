# 24/7 mode

Autostart is off until you turn it on. The checkbox in the bot header and the one on the 24/7 tab are the same setting. It joins the server when the panel opens.

- A bot that is already started retries after a drop or kick: 5 seconds, then 10, 30, and 60. There is no second reconnect switch.
- Ban, whitelist, duplicate login, and Microsoft auth kicks stop the loop. Restart and timeout kicks retry.
- Anti-AFK is off by default. The 24/7 tab sets the move (mixed, look, sneak, jump, swing, or step), the seconds between moves (5 to 600), and how long sneak, jump, and step stay held (100 to 2000 ms). It runs only while the bot is on the ground and no task is already active. While it is on, other actions are refused and a running task is cleared. Chat still works. There is no sprint.
- Autostart can wait extra seconds after the panel opens before this bot joins. That delay is 0 to 300 seconds and is saved with the bot. The header checkbox uses the same on/off flag.
- The login plugin can wait for the server, send `/login` on every join, or send `/register` on the first join and `/login` after that. A line that offers both `/login` and `/register` uses login. Register from a prompt runs only when the server says the account is not registered. Player lines such as `<Steve> /login` are ignored. A custom command is matched only in a server line. The password is stored, encrypted, in `data/login-secrets.json.sealed`, not in the bot config. It is saved exactly as typed, spaces included. Login and register can send the password once, twice, or through a custom command that contains `{password}`. Chat history stores the command with the password replaced by dots.
- Uptime, session count, and the last 20 disconnect reasons are in `data/uptime.json` and survive a panel restart.

The two-hour idle-kick check is not part of `npm run test:all`. The automated check covers the backoff, the kick classes, and the "do nothing while a task is running" rule.

## MCP tools

`always_on_get`, `always_on_set`, `login_plugin_set`, `uptime_stats`, `reconnect_status`, and `reconnect_cancel` are registered with the other agent tools. `login_plugin_set` can write a password and never returns it.

## No sleeping-server preset

Issue #28 planned a one-click "sleeping-server" preset (and an `always_on_apply_preset` tool) for hosts that stop the server when it is empty. It was dropped and does not exist in the panel or in MCP. The same result comes from the normal settings: turn on autostart, leave reconnect on (it already retries 5, 10, 30 and 60 seconds, and restart or "server starting" kicks keep retrying), and turn on anti-AFK if the host also kicks idle players.

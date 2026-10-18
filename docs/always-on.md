# 24/7 mode

Autostart is off until you turn it on in the 24/7 tab. It joins the server when the panel opens.

- A bot that is already started retries after a drop or kick: 5 seconds, then 10, 30, and 60. There is no second reconnect switch.
- Ban, whitelist, duplicate login, and Microsoft auth kicks stop the loop. Restart and timeout kicks retry.
- Anti-AFK is off by default. It runs only while the bot is on the ground and no task is active. Mixed mode picks a short look, sneak, arm swing, step, or jump. A chosen mode repeats that one action. There is no sprint.
- The login plugin can wait for the server, send `/login` on every join, or send `/register` on the first join and `/login` after that. A line that offers both `/login` and `/register` uses login. Register from a prompt runs only when the server says the account is not registered. Player lines such as `<Steve> /login` are ignored. A custom command is matched only in a server line. The password is stored in `data/login-secrets.json`, not in the bot config. Login and register can send the password once, twice, or through a custom command that contains `{password}`. Chat history stores the command with the password replaced by dots.
- Uptime, session count, and the last 20 disconnect reasons are in `data/uptime.json` and survive a panel restart.

The two-hour idle-kick check is not part of `npm run test:all`. The automated check covers the backoff, the kick classes, and the "do nothing while a task is running" rule.

## MCP tools

`always_on_get`, `always_on_set`, `login_plugin_set`, `uptime_stats`, `reconnect_status`, and `reconnect_cancel` are registered with the other agent tools. `login_plugin_set` can write a password and never returns it. The sleeping-server preset tool is not registered.

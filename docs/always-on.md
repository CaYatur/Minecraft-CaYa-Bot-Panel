# 24/7 mode

Autostart is off until you turn it on in the 24/7 tab. It joins the server when the panel opens.

- A bot that is already started retries after a drop or kick: 5 seconds, then 10, 30, and 60. There is no second reconnect switch.
- Ban, whitelist, duplicate login, and Microsoft auth kicks stop the loop. Restart and timeout kicks retry.
- Anti-AFK is off by default. It runs only while the bot is on the ground and no task is active. Mixed mode picks a short look, sneak, arm swing, step, or jump. A chosen mode repeats that one action. There is no sprint.
- The login plugin sends the password only when the server chat asks. A line that offers both `/login` and `/register` uses login. Register runs only when the server says the account is not registered. The password is stored in `data/login-secrets.json`, not in the bot config. Login and register can send the password once, twice, or through a custom command that contains `{password}`. Chat history stores the command with the password replaced by dots.
- Uptime, session count, and the last 20 disconnect reasons are in `data/uptime.json` and survive a panel restart.

The two-hour idle-kick check is not part of `npm run test:all`. The automated check covers the backoff, the kick classes, and the "do nothing while a task is running" rule.

# 24/7 mode

Each bot has an `alwaysOn` block. It is off until you enable it on the bot page.

- Reconnect uses exponential backoff with jitter, capped by `maxMs`. `maxAttempts` of 0 retries forever. The attempt counter resets after the bot has stayed online for `stableMs` (two minutes by default).
- Ban, whitelist, duplicate login, and Microsoft auth kicks stop the loop. Restart and timeout kicks retry.
- Reconnect is not autostart. Autostart joins when the panel opens. Reconnect retries after a drop.
- Anti-AFK only runs while the bot is on the ground and no task is active. Mixed mode picks a short look, sneak, arm swing, step, or jump. A chosen mode repeats that one action. There is no sprint.
- The login-plugin password is stored in `data/login-secrets.json`, not in the bot config. Login and register can send the password once, twice, or through a custom command that contains `{password}`. Chat history stores the command with the password replaced by dots.
- The sleeping-server preset turns reconnect and anti-AFK on with a longer backoff. It does not change autostart.
- Uptime, session count, and the last 20 disconnect reasons are in `data/uptime.json` and survive a panel restart.

The two-hour idle-kick check is not part of `npm run test:all`. The automated check covers the backoff, the kick classes, and the "do nothing while a task is running" rule.

# 24/7 mode

Each bot has an `alwaysOn` block. It is off until you enable it on the bot page.

- Reconnect uses exponential backoff with jitter, capped by `maxMs`. `maxAttempts` of 0 retries forever. The attempt counter resets after the bot has stayed online for `stableMs` (two minutes by default).
- Ban, whitelist, duplicate login, and Microsoft auth kicks stop the loop. Restart and timeout kicks retry.
- Anti-AFK only runs while the bot is on the ground and no task is active. The actions are a short look, sneak, arm swing, step, or jump. There is no sprint.
- The login-plugin password is stored in `data/login-secrets.json`, not in the bot config. The panel shows whether a password exists. Login can send the password once or twice, and register can do the same. Chat history stores `/login ••••` or `/login •••• ••••`.
- The sleeping-server preset turns reconnect and anti-AFK on with a longer backoff.
- Uptime, session count, and the last 20 disconnect reasons are in `data/uptime.json` and survive a panel restart.

The two-hour idle-kick check is not part of `npm run test:all`. The automated check covers the backoff, the kick classes, and the "do nothing while a task is running" rule.

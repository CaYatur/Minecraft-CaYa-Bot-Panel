# Discord

Discord is optional. The panel starts without a token.

1. Create a webhook and paste it on Settings. Test webhook sends one line, `CaYa Bot Panel webhook test`. The URL is stored in `data/discord-secrets.json` and the status view shows only a masked URL. Real notices stay off until you tick an event.
2. Tick the events you want: death, disconnect, reconnect, mention, whisper, task finished, task failed, low health. They are off by default.
3. For slash commands, paste a bot token and a guild id, then invite the bot with the `applications.commands` scope. The gateway status is shown on the same card. An empty user and role allowlist denies every command with an ephemeral reply.
4. `/bot say` sends chat text. It refuses a line that starts with `/` unless `sayAllowsCommands` is saved as true.
5. The chat bridge posts Minecraft lines to one channel as `[MC]` and writes Discord lines back as `[Discord]`. The bot's own lines and those prefixes are not echoed. Mentions such as `@everyone` are escaped, and Discord receives `allowed_mentions: none`. The bridge keeps at most 50 messages a minute and drops lines while Discord is down.

Tokens and webhook URLs are not written to the panel log.

## MCP tools

`discord_status`, `discord_notify`, `discord_events_set`, `discord_bridge_get`, `discord_bridge_set`, `discord_allowlist_get`, `discord_allowlist_set`, and `discord_recent_messages` are registered with the other agent tools. Status results mask the token and the webhook URL.

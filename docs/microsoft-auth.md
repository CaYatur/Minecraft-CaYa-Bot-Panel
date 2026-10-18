# Microsoft accounts

Bots can join online-mode servers with a Microsoft account. Offline bots stay on `auth: "offline"` and do not change.

## Sign in

1. Open **Accounts** in the panel.
2. Enter a label and choose **Add Microsoft account**.
3. The dialog shows a device code and a link (`https://www.microsoft.com/link`).
4. Use **Copy code** and **Open link**. Approve the Minecraft Java license on that account.
5. After the profile loads, the account shows the premium username and a skin head.
6. Create a bot, or open a bot and set **Login** to **Microsoft**, then pick the account and save.
7. Start the bot. The next panel restart reconnects with the saved cache and does not ask for a code again.

If the refresh token expires, auto-reconnect stops and asks you to sign in again. It does not open a new device-code loop by itself.

## More than one account

Add each account separately. Assign them to different bots. Starting a second bot on an account that is already connecting or online is rejected, because the server would kick one of the sessions.

**Sign out** deletes the token cache and keeps the account row. **Remove** deletes the cache and switches linked bots back to offline auth.

## What is stored

- `data/auth/accounts.json` stores the label, premium username, UUID, and skin URL. It does not store tokens.
- Token files live in `data/auth/<accountId>/`. On Windows the folder ACL is limited to the current user. On Unix the directory is `0700` and cache files are `0600`.
- When Electron `safeStorage` is available in the server process, cache JSON is sealed at rest. The packaged server is started with `ELECTRON_RUN_AS_NODE`, so that seal is skipped there and the user-only folder permission is the control.
- Tokens are not sent on Socket.IO, not written to the panel log, and not included in bot config.

The device code is shown only to the panel client that started the login.

## Servers

An offline bot kicked for premium verification is told to switch to Microsoft auth. A Microsoft bot kicked for an invalid session is told to sign in again. Both cases stop auto-reconnect.

## MCP tools

`account_list`, `account_login_start`, `account_login_status`, `account_remove`, `bot_set_account`, and `bot_auth_status` are registered with the other agent tools. They return JSON and never include tokens. `list_bots` and `get_status` include the auth type and premium username.

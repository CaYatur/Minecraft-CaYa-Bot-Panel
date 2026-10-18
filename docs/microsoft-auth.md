# Microsoft accounts

Bots can join online-mode servers with a Microsoft account. Offline bots stay on `auth: "offline"` and do not change.

## Sign in

1. Open **Accounts** in the panel.
2. Enter a label and choose **Add Microsoft account**.
3. The dialog shows a device code and a link (`https://www.microsoft.com/link`).
4. Use **Copy code** and **Open link**. Approve the Minecraft Java license on that account. Microsoft shows the app as **Minecraft for Nintendo Switch**. That is the normal Java sign-in title this panel uses. It does not buy or launch the Switch edition.
5. After the profile loads, the account shows the premium username and a skin head.
6. Create a bot, or open a bot and set **Login** to **Microsoft**, then pick the account and save.
7. Start the bot. The next panel restart reconnects with the saved cache and does not ask for a code again.

If the refresh token expires, auto-reconnect stops and asks you to sign in again. It does not open a new device-code loop by itself.

## More than one account

Add each account separately. Assign them to different bots. Starting a second bot on an account that is already connecting or online is rejected, because the server would kick one of the sessions.

A signed-in account shows **Sign in again**. Starting that and then pressing **Cancel** keeps the saved login until you press **Sign out**. **Sign out** asks for confirmation, then deletes the token cache and keeps the account row. The button is disabled when the account is not signed in. **Remove** deletes the cache and switches linked bots back to offline auth.

If Microsoft accepts the account but the server rejects the join (for example the same player is already online), the dialog stays open and shows that error. Closing it does not sign the account out.

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

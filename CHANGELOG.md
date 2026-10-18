# Changelog

All notable changes to Minecraft CaYa Bot Panel. Dates are release dates.

## About the version numbers

The release after **1.0.4** is **3.0.5**. There was never a 2.x release and no 3.0.0–3.0.4.

The work that followed 1.0.4 (Microsoft accounts, 24/7 mode, Discord, automation templates, the bot view and the Windows installer) was first marked 1.0.5. That tag was withdrawn before it was published, and the batch was released as 3.0.5 instead, because it changed how the panel is used far more than a patch release would suggest (sign-in, stored secrets, a desktop installer). Nothing was skipped: every change between 1.0.4 and 3.0.5 is listed under 3.0.5 below. From 3.0.5 on, versions move one step at a time again.

## 3.0.6 — Unreleased

Stabilization and bug-fix release.

### Security
- **Secrets are encrypted at rest.** Microsoft token caches, the Discord bot token and webhook URL, and login-plugin passwords are sealed with AES-256-GCM. The data key is kept by the desktop app's main process, protected by the OS keychain (Windows DPAPI through Electron `safeStorage`), and handed to the backend over the existing process channel.
- Microsoft sign-in uses an in-memory token cache that persists only the sealed form, so token JSON is no longer written to disk in clear text.
- Existing plaintext files (`*_live-cache.json`, `*_mca-cache.json`, `*_xbl-cache.json`, `discord-secrets.json`, `login-secrets.json`) are encrypted on first start and the plaintext copies are overwritten and deleted.
- When encryption is not available (plain `npm run dev`, or no OS keychain), the panel shows a warning banner instead of failing silently.
- The MCP bearer token is sealed the same way in `mcp-token.json.sealed` and no longer stored in `mcp.json`. An existing token is moved on first start (the old `mcp.json` is wiped and rewritten without it), so connected MCP clients keep working.
- The whole data folder is restricted to the current user on Windows (`icacls`, recursive). It no longer skips this when `USERNAME` is empty.
- The REST API, Socket.IO and `/mcp` check the `Host` and `Origin` headers. Requests from other web pages (CSRF) and DNS-rebinding hosts are refused with 403. MCP clients and scripts that send no `Origin` keep working. Extra host names can be allowed with `CAYA_ALLOWED_HOSTS`.
- Discord webhook calls, including **Test webhook**, only go to `https://discord.com/api/webhooks/…` (or `discordapp.com`). Other URLs are rejected before any request and redirects are not followed.

### Fixes
- Login-plugin passwords are stored exactly as typed. Leading and trailing spaces are no longer trimmed.
- Closing the Microsoft sign-in dialog, or letting the device code expire, now moves the bot to **stopped** with a clear message instead of leaving it in an error or connecting state.
- The 3D bot view checks free memory first and limits how many views run at once (1–3, by CPU count). A second tab on the same bot reuses the running view instead of restarting it. The view closes when the bot disconnects or reconnects, instead of staying attached to the old connection.
- Web panel review: see the 3.0.6 UI notes in the pull request (states, validation, secret fields, translations, layout, accessibility).

### Packaging
- The Windows release ships only the **Setup (NSIS)** installer plus `SHA256SUMS.txt`. The portable exe is no longer built.
- `npm run test:packaging` checks the build config and that the viewer, Discord, canvas and headless GL modules are production dependencies, so they are copied into the installed app.

### Tests
- New `npm run test:security`: crypto round trip, tamper detection, migration of plaintext files, the encrypted token cache, untrimmed passwords, webhook URL rules, Host/Origin rules, the Windows ACL arguments and the viewer limits.

## 3.0.5 — 2026-10-18

- Microsoft (premium) device-code sign-in with several cached accounts.
- 24/7 mode: autostart with delay, reconnect after a drop, anti-AFK settings, login-plugin auto `/login` and `/register`, uptime statistics.
- Discord: webhook notices, a guild slash-command bot and a two-way chat bridge.
- Automation templates with bundled examples.
- Bot view: local 3D page and a first-person PNG for MCP.
- Windows installer (NSIS).
- Baseline, movement, build and platform test suites in CI.

## 1.0.4 — 2026-09-30

Movement, farming, gathering, MLG and protocol-update fixes.

## 1.0.0 – 1.0.3 — 2026-07 to 2026-08

First public releases.

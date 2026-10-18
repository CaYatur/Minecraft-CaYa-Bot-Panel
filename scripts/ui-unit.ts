/**
 * Panel helpers that do not need a browser: secret masking, form rules,
 * dialog focus trap / topmost logic, and the /mcp browser-navigation split.
 */
import { maskSecret } from "../web/src/lib/secrets";
import { looksLikeDiscordWebhook, templateValid } from "../web/src/lib/validate";
import { isTopmost, nextTrapIndex, pickReturnTarget } from "../web/src/lib/dialog";
import { isBrowserNavigation } from "../server/src/modules/agent/mcpHttp";

let failures = 0;
function assert(name: string, cond: boolean) {
  if (cond) console.log(`  ok ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`);
  }
}

const token = "0123456789abcdef0123456789abcdef";
const command = `client mcp add --transport http caya-bot http://127.0.0.1:3001/mcp --header "Authorization: Bearer ${token}"`;
const masked = maskSecret(command, token);
assert("install command hides the token", !masked.includes(token) && masked.endsWith(`${"•".repeat(12)}cdef"`));
assert("rest of the command stays readable", masked.startsWith("client mcp add --transport http caya-bot http://127.0.0.1:3001/mcp"));
assert("empty secret leaves text unchanged", maskSecret("abc", "") === "abc");

assert("template without {password} is invalid", !templateValid("/login"));
assert("template with {password} is valid", templateValid("/l {password}"));
assert("empty template means default command", templateValid(""));
assert("webhook rule matches the server", looksLikeDiscordWebhook("https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123") && !looksLikeDiscordWebhook("https://evil.test/api/webhooks/1/2"));

assert("Tab wraps to the first element", nextTrapIndex(3, 2, false) === 0);
assert("Shift+Tab wraps to the last element", nextTrapIndex(3, 0, true) === 2);
assert("focus outside the trap enters at the start", nextTrapIndex(3, -1, false) === 0);
assert("only the topmost dialog handles keys", isTopmost([1, 2], 2) && !isTopmost([1, 2], 1) && !isTopmost([], 1));

const el = (name: string, isConnected = true, disabled = false) => ({ name, isConnected, disabled });
assert("focus returns to an enabled opener", pickReturnTarget([el("opener"), el("label")])?.name === "opener");
assert("disabled opener falls back to the given field", pickReturnTarget([el("opener", true, true), el("label")])?.name === "label");
assert("removed opener falls back to the given field", pickReturnTarget([el("opener", false), el("label")])?.name === "label");
assert("missing fallback uses the nearest focusable", pickReturnTarget([el("opener", true, true), null, el("nearest")])?.name === "nearest");
assert("nothing usable returns null", pickReturnTarget([null, el("x", false)]) === null);

const nav = (headers: Record<string, string>) => isBrowserNavigation({ headers });
assert("browser reload of /mcp is a navigation", nav({ accept: "text/html,application/xhtml+xml,*/*;q=0.8" }));
assert("MCP SSE probe is not a navigation", !nav({ accept: "text/event-stream" }));
assert("MCP client with both types is not a navigation", !nav({ accept: "text/html, text/event-stream" }));
assert("MCP session header is not a navigation", !nav({ accept: "text/html", "mcp-session-id": "x" }));
assert("JSON client is not a navigation", !nav({ accept: "application/json" }));

if (failures) {
  console.log(`\n${failures} ui check(s) failed`);
  process.exit(1);
}
console.log("\nui checks passed");

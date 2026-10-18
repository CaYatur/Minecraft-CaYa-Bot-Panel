/**
 * Microsoft auth checks that do not call Microsoft.
 * If the panel API is already running, also checks offline bots and account validation.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AccountStore, assertMicrosoftUrl } from "../server/src/modules/auth/accounts";
import { classifyKick } from "../server/src/modules/auth/messages";
import { redactSecrets } from "../server/src/utils/redact";

const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
let failures = 0;
const ok = (name: string) => console.log(`  ok ${name}`);
const fail = (name: string, detail?: string) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) ok(name);
  else fail(name, detail);
}

function unit() {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const redacted = redactSecrets(`token ${jwt} access_token=secretvalue`);
  assert("redact jwt", !redacted.includes(jwt) && redacted.includes("[redacted]"));
  assert("redact access token", !redacted.includes("secretvalue"));

  const offline = classifyKick("Server requires premium verification", "offline");
  assert("offline premium kick stops reconnect", offline.stop && offline.code === "auth.mismatchOffline");
  const premium = classifyKick("invalid session", "microsoft");
  assert("microsoft invalid session stops reconnect", premium.stop && premium.code === "auth.sessionRejected");
  const other = classifyKick("Server is full.", "offline");
  assert("unrelated kick does not stop reconnect", !other.stop);

  let rejected = false;
  try {
    assertMicrosoftUrl("https://evil.example/link");
  } catch {
    rejected = true;
  }
  assert("reject non-Microsoft URL", rejected);
  assert("allow Microsoft link", assertMicrosoftUrl("https://www.microsoft.com/link").hostname === "www.microsoft.com");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caya-auth-"));
  const store = new AccountStore(dir);
  const row = store.createRecord("Unit");
  const pub = store.publicView([]);
  const dumped = JSON.stringify(pub) + fs.readFileSync(path.join(dir, "accounts.json"), "utf8");
  assert("public account has no token fields", !/accessToken|refreshToken|device_code|userCode/.test(dumped));
  assert("new account is not cached", pub[0]?.tokenStatus === "none" && pub[0]?.id === row.id);
  store.remove(row.id);
  assert("remove deletes cache folder", !fs.existsSync(path.join(dir, row.id)));
  assert("remove drops the account", store.publicView([]).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function integration() {
  let state: { bots?: Array<{ config: { id: string; username: string; auth?: string } }>; servers?: Array<{ id: string; name: string }> };
  try {
    const res = await fetch(API + "/state");
    if (!res.ok) throw new Error(String(res.status));
    state = (await res.json()) as typeof state;
  } catch {
    console.log("  skip API checks (panel is not running)");
    return;
  }

  const serverRes = await fetch(API + "/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "AuthUnit", host: "127.0.0.1", port: 25566, version: "1.16.1" })
  });
  const server = (await serverRes.json()) as { id?: string; error?: string };
  if (!serverRes.ok || !server.id) {
    fail("create server profile", server.error);
    return;
  }

  const botRes = await fetch(API + "/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "AuthUnitBot", serverId: server.id, startNow: false })
  });
  const bot = (await botRes.json()) as { config?: { id: string; auth?: string; accountId?: string | null }; error?: string };
  assert("offline bot defaults to offline auth", botRes.ok && bot.config?.auth === "offline" && !bot.config.accountId, bot.error);

  const bad = await fetch(API + "/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "AuthUnitMs", serverId: server.id, auth: "microsoft", startNow: false })
  });
  assert("microsoft bot without an account is rejected", bad.status === 400);

  const accountsRes = await fetch(API + "/accounts");
  const body = await accountsRes.text();
  assert("account list has no secrets", accountsRes.ok && !/accessToken|device_code|refresh_token/.test(body));

  const evil = await fetch(API + "/system/open-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://evil.example/phish" })
  });
  assert("open-url rejects other hosts", evil.status === 400);

  if (bot.config?.id) await fetch(API + "/bots/" + bot.config.id, { method: "DELETE" });
  await fetch(API + "/servers/" + server.id, { method: "DELETE" });
  ok("cleaned auth fixtures");
}

async function main() {
  console.log("— auth unit —");
  unit();
  await integration();
  if (failures) {
    console.log(`FAILED ${failures}`);
    process.exit(1);
  }
  console.log("auth checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

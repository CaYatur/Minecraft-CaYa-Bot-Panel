/**
 * Secrets-at-rest and request-guard checks. No network, no Electron.
 * Uses a temporary CAYA_DATA_DIR so nothing touches the real data folder.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "caya-sec-"));
process.env.CAYA_DATA_DIR = tmpRoot;
// Account folders are created and renamed quickly here; keep ACL tools out of the way.
process.env.CAYA_SKIP_ACL = "1";

let failures = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

/** True when any file under dir contains the needle in clear text. */
function plaintextOnDisk(dir: string, needle: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = plaintextOnDisk(full, needle);
      if (hit) return hit;
    } else if (fs.readFileSync(full).includes(needle)) return full;
  }
  return null;
}

async function main() {
  const box = await import("../server/src/security/secretBox");
  const guard = await import("../server/src/security/httpGuard");
  const perms = await import("../server/src/security/permissions");
  const logic = await import("../server/src/modules/discord/logic");
  const cacheMod = await import("../server/src/modules/auth/encryptedCache");
  const view = await import("../server/src/modules/view/session");

  console.log("crypto helper");
  const key = crypto.randomBytes(32);
  const sealed = box.sealString("refresh-token-123", key);
  assert("sealed text hides the plaintext", !sealed.includes("refresh-token-123"));
  assert("round trip", box.openString(sealed, key) === "refresh-token-123");
  assert("two seals differ (random IV)", box.sealString("x", key) !== box.sealString("x", key));
  let wrongKey = false;
  try {
    box.openString(sealed, crypto.randomBytes(32));
  } catch {
    wrongKey = true;
  }
  assert("wrong key is rejected", wrongKey);
  let tampered = false;
  try {
    const parsed = JSON.parse(sealed);
    const data = Buffer.from(parsed.data, "base64");
    data[0] ^= 1;
    parsed.data = data.toString("base64");
    box.openString(JSON.stringify(parsed), key);
  } catch {
    tampered = true;
  }
  assert("tampered data is rejected (GCM tag)", tampered);

  console.log("migration");
  const dir = path.join(tmpRoot, "mig");
  fs.mkdirSync(dir, { recursive: true });
  const plainFile = path.join(dir, "discord-secrets.json");
  fs.writeFileSync(plainFile, JSON.stringify({ token: "DISCORD-SECRET-TOKEN" }));
  box.setSecretKeyForTests(null);
  assert("no key: plaintext is still readable", box.readSecretJson<{ token?: string }>(plainFile, {}).token === "DISCORD-SECRET-TOKEN");
  assert("no key: status reports unencrypted", !box.secretStatus().encrypted);
  box.setSecretKeyForTests(key);
  assert("with key: status reports encrypted", box.secretStatus().encrypted);
  assert("with key: old plaintext is read", box.readSecretJson<{ token?: string }>(plainFile, {}).token === "DISCORD-SECRET-TOKEN");
  assert("migration removes the plaintext file", !fs.existsSync(plainFile));
  assert("migration writes the sealed file", fs.existsSync(plainFile + box.SEALED_SUFFIX));
  assert("no plaintext token left on disk", plaintextOnDisk(dir, "DISCORD-SECRET-TOKEN") === null);
  box.writeSecretJson(plainFile, { token: "NEXT" });
  assert("write keeps only the sealed file", !fs.existsSync(plainFile) && box.readSecretJson<{ token?: string }>(plainFile, {}).token === "NEXT");
  fs.writeFileSync(path.join(dir, "abc123_live-cache.json"), JSON.stringify({ refresh_token: "LIVE-REFRESH" }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
  const moved = box.migratePlaintextIn(dir, /-cache\.json$/);
  assert("bulk migration seals matching files only", moved === 1 && fs.existsSync(path.join(dir, "notes.txt")));
  assert("bulk migration leaves no refresh token in clear", plaintextOnDisk(dir, "LIVE-REFRESH") === null);
  box.deleteSecretFile(plainFile);
  assert("delete removes plain and sealed copies", !fs.existsSync(plainFile) && !fs.existsSync(plainFile + box.SEALED_SUFFIX));

  console.log("token cache");
  const authDir = path.join(tmpRoot, "auth", "acc1");
  fs.mkdirSync(authDir, { recursive: true });
  const factory = cacheMod.encryptedCacheFactory(authDir);
  const live = factory({ cacheName: "live", username: "acc1" });
  await live.setCached({ token: { refresh_token: "MS-REFRESH-XYZ", access_token: "MS-ACCESS-XYZ" } });
  await live.setCachedPartial({ extra: 1 });
  const expectedName = cacheMod.authCacheFileName("acc1", "live");
  assert("file name matches the library's naming", expectedName === `${crypto.createHash("sha1").update("acc1", "binary").digest("hex").slice(0, 6)}_live-cache.json`);
  assert("cache persists sealed only", fs.existsSync(path.join(authDir, expectedName + box.SEALED_SUFFIX)) && !fs.existsSync(path.join(authDir, expectedName)));
  assert("no Microsoft token in clear on disk", plaintextOnDisk(authDir, "MS-REFRESH-XYZ") === null && plaintextOnDisk(authDir, "MS-ACCESS-XYZ") === null);
  cacheMod.forgetCachedTokens(authDir);
  const reread = (await factory({ cacheName: "live", username: "acc1" }).getCached()) as { token?: { refresh_token?: string }; extra?: number };
  assert("cache reloads from the sealed file", reread.token?.refresh_token === "MS-REFRESH-XYZ" && reread.extra === 1);

  const { AccountStore } = await import("../server/src/modules/auth/accounts");
  const storeDir = path.join(tmpRoot, "store");
  const store = new AccountStore(storeDir);
  const row = store.createRecord("Mig");
  const legacy = path.join(storeDir, row.id, cacheMod.authCacheFileName(row.id, "mca"));
  fs.writeFileSync(legacy, JSON.stringify({ mca: { access_token: "LEGACY-MCA" } }));
  store.seal(row.id);
  assert("account migration seals a legacy cache", !fs.existsSync(legacy) && fs.existsSync(legacy + box.SEALED_SUFFIX));
  assert("account with sealed cache counts as signed in", store.hasCache(row.id));
  assert("legacy token gone from disk", plaintextOnDisk(storeDir, "LEGACY-MCA") === null);
  store.signOut(row.id);
  assert("sign-out removes sealed cache", !store.hasCache(row.id));

  console.log("login secrets");
  const secrets = await import("../server/src/modules/alwaysOn/secrets");
  secrets.writeLoginSecret("bot1", "  pass word  ");
  assert("password is stored untrimmed", secrets.readLoginSecret("bot1") === "  pass word  ");
  assert("login secrets are sealed", plaintextOnDisk(tmpRoot, "pass word") === null);
  secrets.writeLoginSecret("bot1", "");
  assert("empty password clears it", secrets.readLoginSecret("bot1") === null);

  console.log("discord webhook URL");
  const id = "123456789012345678";
  const tok = "abcdefghijklmnopqrstuvwxyzABCDEF_-123";
  assert("discord.com webhook allowed", logic.isDiscordWebhookUrl(`https://discord.com/api/webhooks/${id}/${tok}`));
  assert("discordapp.com webhook allowed", logic.isDiscordWebhookUrl(`https://discordapp.com/api/webhooks/${id}/${tok}`));
  assert("versioned API path allowed", logic.isDiscordWebhookUrl(`https://discord.com/api/v10/webhooks/${id}/${tok}`));
  for (const bad of [
    `http://discord.com/api/webhooks/${id}/${tok}`,
    `https://discord.com.evil.test/api/webhooks/${id}/${tok}`,
    `https://evil.test/api/webhooks/${id}/${tok}`,
    `https://user:pw@discord.com/api/webhooks/${id}/${tok}`,
    `https://discord.com:8443/api/webhooks/${id}/${tok}`,
    `https://discord.com/api/users/@me`,
    `https://127.0.0.1/api/webhooks/${id}/${tok}`,
    "file:///etc/passwd",
    "not a url",
    ""
  ]) {
    assert(`rejects ${bad || "(empty)"}`, !logic.isDiscordWebhookUrl(bad));
  }

  console.log("discord settings input");
  const hub = await import("../server/src/modules/discord/hub");
  const clean = hub.sanitizeDiscordPatch({ guildId: "123456789012345678", junk: "x", events: { death: 1, evil: true }, bridge: { enabled: "yes" } });
  assert("unknown keys are dropped", !("junk" in clean) && !("evil" in (clean.events ?? {})));
  assert("event flags become booleans", clean.events?.death === true && clean.bridge?.enabled === true);
  let badId = false;
  try {
    hub.sanitizeDiscordPatch({ guildId: "not-an-id" });
  } catch {
    badId = true;
  }
  assert("non-numeric Discord ID is rejected", badId);
  let badHook = false;
  try {
    hub.updateDiscordSettings({ webhookUrl: "https://evil.test/hook" });
  } catch {
    badHook = true;
  }
  assert("saving a non-Discord webhook is rejected", badHook);
  const tested = await hub.testWebhook("http://169.254.169.254/latest/meta-data");
  assert("test webhook refuses internal URLs", !tested.ok);

  console.log("MCP bearer token");
  const mcp = await import("../server/src/modules/agent/settings");
  const mcpFile = path.join(tmpRoot, "mcp.json");
  fs.writeFileSync(mcpFile, JSON.stringify({ enabled: true, mcpServer: { enabled: true, requireToken: true, token: "LEGACY-MCP-TOKEN-abc" } }));
  const loadedMcp = mcp.loadMcpSettings();
  assert("legacy token is kept for existing clients", loadedMcp.mcpServer.token === "LEGACY-MCP-TOKEN-abc");
  assert("token is removed from mcp.json", !fs.readFileSync(mcpFile, "utf8").includes("LEGACY-MCP-TOKEN") && JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServer.requireToken === true);
  assert("token is sealed on disk", fs.existsSync(path.join(tmpRoot, "mcp-token.json" + box.SEALED_SUFFIX)) && plaintextOnDisk(tmpRoot, "LEGACY-MCP-TOKEN") === null);
  assert("reload reads the sealed token", mcp.loadMcpSettings().mcpServer.token === "LEGACY-MCP-TOKEN-abc");
  loadedMcp.mcpServer.token = "ROTATED-MCP-TOKEN-xyz";
  await mcp.saveMcpSettings(loadedMcp);
  assert("save keeps the token out of mcp.json", !fs.readFileSync(mcpFile, "utf8").includes("ROTATED") && plaintextOnDisk(tmpRoot, "ROTATED-MCP-TOKEN") === null);
  assert("rotated token survives a reload", mcp.loadMcpSettings().mcpServer.token === "ROTATED-MCP-TOKEN-xyz");

  console.log("host / origin guard");
  const opts = { bindHost: "127.0.0.1", allowedHosts: [] as string[] };
  assert("panel itself", guard.checkRequest({ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" }, opts).ok);
  assert("localhost name", guard.checkRequest({ host: "localhost:3001" }, opts).ok);
  assert("dev server origin", guard.checkRequest({ host: "localhost:3000", origin: "http://localhost:3000" }, opts).ok);
  assert("IPv6 loopback", guard.checkRequest({ host: "[::1]:3001", origin: "http://[::1]:3001" }, opts).ok);
  assert("MCP client without Origin", guard.checkRequest({ host: "127.0.0.1:3001" }, opts).ok);
  assert("DNS rebinding host blocked", !guard.checkRequest({ host: "attacker.test:3001", origin: "http://attacker.test:3001" }, opts).ok);
  assert("cross-site origin blocked", !guard.checkRequest({ host: "127.0.0.1:3001", origin: "https://evil.test" }, opts).ok);
  assert("null origin blocked", !guard.checkRequest({ host: "127.0.0.1:3001", origin: "null" }, opts).ok);
  assert("cross-site fetch without Origin blocked", !guard.checkRequest({ host: "127.0.0.1:3001", "sec-fetch-site": "cross-site" }, opts).ok);
  assert("missing Host blocked", !guard.checkRequest({}, opts).ok);
  assert("allowed host list", guard.checkRequest({ host: "panel.lan:3001", origin: "http://panel.lan:3001" }, { bindHost: "0.0.0.0", allowedHosts: guard.parseAllowedHosts("panel.lan, other") }).ok);
  assert("explicit LAN bind address accepted", guard.checkRequest({ host: "192.168.1.5:3001" }, { bindHost: "192.168.1.5" }).ok);
  assert("wildcard bind does not open every Host", !guard.checkRequest({ host: "attacker.test" }, { bindHost: "0.0.0.0" }).ok);

  console.log("permissions");
  assert("icacls principal falls back when USERNAME is empty", perms.aclPrincipal({ USERNAME: "" }).length > 0);
  assert("icacls principal uses domain when present", perms.aclPrincipal({ USERNAME: "u", USERDOMAIN: "D" }) === "D\\u");
  const args = perms.icaclsArgs("C:\\data", "u");
  assert("hardening is top-level and inheritable, not /T", !args.includes("/T") && args.includes("/inheritance:r") && args.includes("u:(OI)(CI)F"));
  assert("recovery resets children recursively", perms.icaclsResetArgs("C:\\data").join(" ") === "C:\\data /reset /T /C /Q");
  const winDir = fs.mkdtempSync(path.join(os.tmpdir(), "caya-acl-"));
  const calls: string[] = [];
  const fakeRun = (failReset: boolean) => async (cmd: string, a: string[]) => {
    calls.push(`${cmd} ${a.join(" ")}`);
    if (cmd === "whoami") return { ok: true, out: '"pc\\me","S-1-5-21-1-2-3-1001"' };
    if (cmd === "icacls" && a.includes("/reset") && failReset && calls.filter((c) => c.includes("/reset")).length === 1) return { ok: false, out: "Access is denied." };
    return { ok: true, out: "" };
  };
  const steps = await perms.hardenDataDir(winDir, "win32", fakeRun(false));
  assert("startup resets before hardening", steps.join(",") === "reset,harden");
  assert("hardening uses the user SID", calls.some((c) => c.includes("*S-1-5-21-1-2-3-1001:(OI)(CI)F")));
  calls.length = 0;
  const steps2 = await perms.hardenDataDir(winDir, "win32", fakeRun(true));
  assert("refused reset takes ownership and retries", steps2.join(",") === "reset,takeown,reset,harden" && calls.some((c) => c.startsWith("takeown /F")));
  fs.rmSync(winDir, { recursive: true, force: true });

  console.log("viewer limits");
  assert("viewer refuses on low memory", !view.viewerResourceCheck({ freeMb: 100, cpuCount: 8, running: 0 }).ok);
  assert("viewer cap on 2 cores is 1", view.maxViewers(2) === 1 && !view.viewerResourceCheck({ freeMb: 4000, cpuCount: 2, running: 1 }).ok);
  assert("replacing a bot's own view is allowed", view.viewerResourceCheck({ freeMb: 4000, cpuCount: 2, running: 1, replacing: true }).ok);
  assert("viewer cap never above 3", view.maxViewers(64) === 3);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} security check(s) failed`);
    process.exit(1);
  }
  console.log("\nsecurity checks passed");
  process.exit(0);
}

void main();

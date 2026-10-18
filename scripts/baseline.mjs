/**
 * Current-behavior contract for the panel API.
 *
 * Prerequisite: `npm run dev:server` and `npm run testserver`
 * (flying-squid, offline, 127.0.0.1:25566, Minecraft 1.16.1).
 *
 * This file records how the panel works today. A product change that breaks
 * one of these checks should fail here, then the check is updated on purpose.
 * It does not call Microsoft and it does not install mineflayer.
 */
import net from "net";

const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
const MC_PORT = Number(process.env.CAYA_TEST_MC_PORT || 25566);

let failures = 0;
const created = { servers: [], bots: [], rules: [], waypoints: [] };

const ok = (name) => console.log(`  ok ${name}`);
const fail = (name, detail) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};

function assert(name, cond, detail) {
  if (cond) ok(name);
  else fail(name, detail);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${data.error ?? "?"}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitOnline(id, timeoutMs = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const state = await req("GET", "/state");
    const bot = (state.bots || []).find((row) => row.config.id === id);
    if (!bot) throw new Error("bot disappeared");
    if (bot.status === "online") return bot;
    if (bot.status === "error" || bot.status === "kicked") {
      const why = bot.runtime?.errorCode || bot.runtime?.lastError || bot.runtime?.kickReason || bot.status;
      throw new Error(String(why));
    }
    await sleep(1000);
  }
  throw new Error("timed out waiting for spawn");
}

function track(kind, id) {
  created[kind].push(id);
}

async function cleanup() {
  for (const id of created.bots) await req("POST", `/bots/${id}/stop`).catch(() => {});
  for (const id of created.bots) await req("DELETE", `/bots/${id}`).catch(() => {});
  for (const id of created.rules) await req("DELETE", `/rules/${id}`).catch(() => {});
  for (const id of created.waypoints) await req("DELETE", `/waypoints/${id}`).catch(() => {});
  for (const id of created.servers) await req("DELETE", `/servers/${id}`).catch(() => {});
  const state = await req("GET", "/state").catch(() => null);
  if (!state) return;
  for (const bot of state.bots || []) {
    if (String(bot.config?.username || "").startsWith("Baseline")) {
      await req("POST", `/bots/${bot.config.id}/stop`).catch(() => {});
      await req("DELETE", `/bots/${bot.config.id}`).catch(() => {});
    }
  }
  for (const server of state.servers || []) {
    if (server.name === "Baseline") await req("DELETE", `/servers/${server.id}`).catch(() => {});
  }
  const rules = await req("GET", "/rules").catch(() => []);
  for (const rule of rules) {
    if (String(rule.name || "").startsWith("Baseline")) await req("DELETE", `/rules/${rule.id}`).catch(() => {});
  }
}

async function expectStatus(name, method, path, status, body) {
  try {
    await req(method, path, body);
    fail(name, "request succeeded");
  } catch (err) {
    assert(name, err.status === status, err.message);
  }
}

async function main() {
  console.log("— baseline —\n");
  let state;
  try {
    state = await req("GET", "/state");
  } catch (err) {
    fail("API is up", err.message);
    console.log("\nStart the panel with: npm run dev:server");
    process.exit(1);
  }
  ok("API is up");

  assert("state has bots, servers, rules, world memory, accounts",
    Array.isArray(state.bots) && Array.isArray(state.servers) && Array.isArray(state.rules) &&
    state.worldMemory && Array.isArray(state.worldMemory.chests) && Array.isArray(state.accounts));
  assert("supported versions include 1.16.5 and 26.1",
    Array.isArray(state.supportedVersions) && state.supportedVersions.includes("1.16.5") && state.supportedVersions.includes("26.1"),
    (state.supportedVersions || []).join(", "));

  const versions = await req("GET", "/versions");
  assert("version status shape",
    typeof versions.installedMineflayer === "string" &&
    typeof versions.supportedCount === "number" && versions.supportedCount === state.supportedVersions.length &&
    typeof versions.offerInstall === "boolean" && typeof versions.waitingOnPrismarine === "boolean" &&
    Array.isArray(versions.npmAdds));

  const meta = await req("GET", "/rules/meta");
  assert("stock templates and blueprints are empty",
    Array.isArray(meta.templates) && meta.templates.length === 0 &&
    Array.isArray(meta.blueprints) && meta.blueprints.length === 0);
  assert("rule flow version is 2", meta.flow?.version === 2 && Array.isArray(meta.triggers) && Array.isArray(meta.actions));
  await expectStatus("unknown rule template is 404", "POST", "/rules/templates/Yemek%20n%C3%B6bet%C3%A7isi", 404, { botIds: [] });

  const catalog = await req("GET", "/catalog?version=1.16.1");
  assert("catalog lists items and blocks",
    catalog.resolvedVersion && Array.isArray(catalog.items) && catalog.items.length > 0 &&
    Array.isArray(catalog.blocks) && catalog.blocks.length > 0 && Array.isArray(catalog.ores));

  const schematics = await req("GET", "/schematics");
  assert("schematics list", schematics && Array.isArray(schematics.items));
  await expectStatus("missing schematic is 404", "GET", "/schematics/does-not-exist", 404);

  const logs = await req("GET", "/logs?limit=20");
  assert("log hub is a list", Array.isArray(logs));

  const mcp = await req("GET", "/mcp");
  const toolNames = (mcp.tools || []).map((tool) => tool.name);
  assert("MCP status lists account tools",
    typeof mcp.endpoint === "string" && mcp.endpoint.endsWith("/mcp") &&
    ["list_bots", "account_list", "account_login_start", "bot_set_account", "bot_auth_status"].every((name) => toolNames.includes(name)));
  assert("MCP status has no Microsoft secrets", !/access_token|refresh_token|device_code|"eyJ/.test(JSON.stringify(mcp)));

  const accounts = await req("GET", "/accounts");
  assert("account list has no secrets", Array.isArray(accounts) && !/access_token|refresh_token|device_code/.test(JSON.stringify(accounts)));
  await expectStatus("empty account label is rejected", "POST", "/accounts/login", 400, { label: "" });
  await expectStatus("unknown account sign-out is 404", "POST", "/accounts/missing-account/sign-out", 404, {});
  await expectStatus("open-url rejects other hosts", "POST", "/system/open-url", 400, { url: "https://evil.example/phish" });

  const server = await req("POST", "/servers", {
    name: "Baseline",
    host: "127.0.0.1",
    port: MC_PORT,
    version: "1.16.1"
  });
  track("servers", server.id);
  assert("server profile saved", server.host === "127.0.0.1" && server.port === MC_PORT && server.version === "1.16.1");
  const renamed = await req("PATCH", `/servers/${server.id}`, { note: "baseline" });
  assert("server note saved", renamed.note === "baseline");

  await expectStatus("microsoft bot without an account is rejected", "POST", "/bots", 400, {
    username: "BaselineMs",
    serverId: server.id,
    auth: "microsoft"
  });

  const bot = await req("POST", "/bots", { username: "BaselineBot", serverId: server.id, startNow: false });
  const id = bot.config.id;
  track("bots", id);
  assert("new bot defaults to offline auth", bot.config.auth === "offline" && !bot.config.accountId && bot.combat?.mode === "idle");

  const patched = await req("PATCH", `/bots/${id}`, {
    combat: { defendMode: "all", reach: 3, fleeAtHealth: 6, jumpCrit: true }
  });
  assert("combat defend mode saved", patched.config.combat.defendMode === "all");
  await expectStatus("empty attack is rejected", "POST", `/bots/${id}/action`, 400, { type: "attack", player: "" });
  await expectStatus("loot without a death is rejected", "POST", `/bots/${id}/action`, 400, { type: "loot-death" });
  const eat = await req("POST", `/bots/${id}/action`, { type: "eat" });
  assert("eat can be queued", eat.ok === true);
  const stopped = await req("POST", `/bots/${id}/action`, { type: "stop" });
  assert("stop action accepted", stopped.ok === true);
  await req("POST", `/bots/${id}/tasks/pause`);
  await req("POST", `/bots/${id}/tasks/resume`);
  const history = await req("GET", `/bots/${id}/tasks/history`);
  assert("task history is a list", Array.isArray(history));
  const plan = await req("GET", `/bots/${id}/craft-plan?item=stone_pickaxe&count=1`);
  assert("craft plan has steps", Array.isArray(plan.plan) && plan.plan.length > 0, `steps=${plan.plan?.length ?? 0}`);
  const build = await req("GET", `/bots/${id}/build`);
  assert("build runtime exists", build && typeof build === "object");
  const nearby = await req("GET", `/bots/${id}/nearby`);
  assert("nearby players while offline", nearby && Array.isArray(nearby.players));
  await expectStatus("waypoint-here requires the bot online", "POST", `/bots/${id}/waypoint-here`, 400, { name: "Here" });
  await expectStatus("inventory equip while offline is rejected", "POST", `/bots/${id}/inventory`, 400, { op: "equip", slot: 36 });

  const wp = await req("POST", "/waypoints", {
    serverId: server.id, name: "Baseline", x: 1, y: 64, z: 1, dimension: "overworld"
  });
  track("waypoints", wp.id);
  const wps = await req("GET", `/waypoints?serverId=${server.id}`);
  assert("waypoint listed", wps.some((row) => row.id === wp.id));

  const memory = await req("GET", `/world-memory?serverId=${server.id}`);
  assert("world memory shape", memory && Array.isArray(memory.chests) && Array.isArray(memory.ores));
  await expectStatus("unknown chest forget is 404", "DELETE", "/world-memory/chests/missing-chest", 404);

  const rule = await req("POST", "/rules", {
    name: "Baseline gel",
    enabled: true,
    botIds: [id],
    trigger: { type: "chat", pattern: "gel", match: "contains", from: "authorized" },
    actions: [{ type: "panel_notify", message: "baseline", level: "info" }],
    cooldownMs: 1000
  });
  track("rules", rule.id);
  await req("POST", `/rules/${rule.id}/test`, { botId: id });
  ok("rule dry-test");
  const disabled = await req("PATCH", `/rules/${rule.id}`, { enabled: false });
  assert("rule can be disabled", disabled.enabled === false);

  const bulk = await req("POST", "/bots/bulk", { template: "BaseLn{n}", count: 2, serverId: server.id, startNow: false });
  assert("bulk create makes two offline bots",
    Array.isArray(bulk.created) && bulk.created.length === 2 && bulk.created.every((row) => row.config.auth === "offline"));
  for (const row of bulk.created) track("bots", row.config.id);

  if (!(await portOpen(MC_PORT))) {
    fail("local test server is listening", `127.0.0.1:${MC_PORT} — run npm run testserver`);
  } else {
    ok("local test server is listening");
    await req("POST", `/bots/${id}/start`);
    try {
      const live = await waitOnline(id);
      assert("bot spawned with vitals",
        typeof live.runtime?.health === "number" &&
        typeof live.runtime?.position?.x === "number" &&
        typeof live.runtime?.position?.y === "number");
      const chat = await req("POST", `/bots/${id}/chat`, { text: "baseline" });
      assert("chat accepted", chat.ok === true);
      const here = await req("POST", `/bots/${id}/waypoint-here`, { name: "BaselineHere" });
      track("waypoints", here.id);
      assert("waypoint from live position", here.name === "BaselineHere" && typeof here.x === "number");
      await req("POST", `/bots/${id}/action`, {
        type: "goto",
        x: live.runtime.position.x + 2,
        y: live.runtime.position.y,
        z: live.runtime.position.z
      });
      ok("goto queued while online");
      await sleep(1500);
      await req("POST", `/bots/${id}/action`, { type: "stop" });
      ok("movement stopped");
    } catch (err) {
      fail("bot joined the local test server", err.message);
    }
    await req("POST", `/bots/${id}/stop`).catch(() => {});
  }

  await cleanup();
  const after = await req("GET", "/state");
  assert("baseline fixtures removed",
    !(after.bots || []).some((row) => String(row.config?.username || "").startsWith("Baseline") || String(row.config?.username || "").startsWith("BaseLn")) &&
    !(after.servers || []).some((row) => row.name === "Baseline"));
  const rulesAfter = await req("GET", "/rules");
  assert("baseline rules removed", !rulesAfter.some((rule) => String(rule.name || "").startsWith("Baseline")));

  console.log(failures ? `\nFAILED ${failures}` : "\nbaseline passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});

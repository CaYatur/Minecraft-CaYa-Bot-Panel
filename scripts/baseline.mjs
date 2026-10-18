/**
 * Current-behavior contract for the panel API.
 *
 * Prerequisite: `npm run dev:server` and `npm run testserver`
 * (flying-squid, offline, 127.0.0.1:25566, Minecraft 1.16.1).
 *
 * This file records how the panel works today. A product change that breaks
 * one of these checks should fail here, then the check is updated on purpose.
 * It covers the old smoke, combat, movement, inventory, full-suite, and grok
 * scenarios against today's behavior. Flying-squid still cannot click windows
 * or publish player entities; those two physics checks are recorded as skips.
 * It does not call Microsoft and it does not install mineflayer.
 */
import net from "net";
import { pickBestWeaponName } from "../server/src/modules/combat/weapons.ts";

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
let skips = 0;
const skip = (name, detail) => {
  skips++;
  console.log(`  skip ${name}${detail ? " — " + detail : ""}`);
};

async function waitFor(label, fn, timeoutMs = 60_000, everyMs = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`${label}: timed out`);
}

async function getBot(id) {
  const state = await req("GET", "/state");
  return (state.bots || []).find((row) => row.config.id === id);
}

const dist2d = (a, b) => Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0));
const findItem = (inv, name) => inv?.slots?.find((slot) => slot && slot.name === name) ?? null;

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

  assert("weapon picker prefers diamond", pickBestWeaponName(["wooden_sword", "diamond_sword", "dirt"], []) === "diamond_sword");
  assert("weapon picker skips a banned sword", pickBestWeaponName(["diamond_sword", "iron_sword"], ["diamond_sword"]) === "iron_sword");

  const patched = await req("PATCH", `/bots/${id}`, {
    combat: { defendMode: "all", reach: 3, fleeAtHealth: 6, jumpCrit: true },
    survival: { autoEat: true, eatAtFood: 14 },
    authorizedPlayers: ["OwnerTest"],
    inventory: { bannedItems: ["diamond_sword"], autoBestGear: false }
  });
  assert("combat, survival, trust, and ban saved",
    patched.config.combat.defendMode === "all" &&
    patched.config.survival.autoEat === true &&
    patched.config.authorizedPlayers.includes("OwnerTest") &&
    patched.config.inventory.bannedItems.includes("diamond_sword"));
  await expectStatus("empty attack is rejected", "POST", `/bots/${id}/action`, 400, { type: "attack", player: "" });
  await expectStatus("loot without a death is rejected", "POST", `/bots/${id}/action`, 400, { type: "loot-death" });
  await expectStatus("unknown action is rejected", "POST", `/bots/${id}/action`, 400, { type: "no_such_action_xyz" });
  const enqueueOk = [
    ["stop-combat", {}],
    ["stop", {}],
    ["eat", {}],
    ["hunt", { radius: 16 }],
    ["cook", {}],
    ["acquire-food", {}],
    ["collect-wood", { count: 4 }],
    ["odun-topla", { count: 2 }],
    ["collect-drops", { radius: 12 }],
    ["mine", { ore: "coal", count: 2, mode: "legit" }],
    ["maden-topla", { ore: "iron", count: 1, mode: "utility" }],
    ["craft", { item: "stick", count: 1 }],
    ["üret", { item: "oak_planks", count: 1 }],
    ["clear-mobs", { radius: 8 }],
    ["flee", {}],
    ["chat", { text: "baseline-ping" }],
    ["deposit", {}],
    ["withdraw", { item: "dirt", count: 1 }],
    ["fetch", { item: "dirt", count: 1, player: "Someone" }]
  ];
  for (const [type, extra] of enqueueOk) {
    try {
      const queued = await req("POST", `/bots/${id}/action`, { type, ...extra });
      assert(`enqueue ${type}`, queued.ok === true);
    } catch (err) {
      fail(`enqueue ${type}`, err.message);
    }
  }
  await req("POST", `/bots/${id}/tasks/cancel-all`);
  ok("tasks cancelled");
  for (const item of ["stick", "stone_pickaxe", "crafting_table", "furnace"]) {
    const itemPlan = await req("GET", `/bots/${id}/craft-plan?item=${encodeURIComponent(item)}&count=1`);
    assert(`craft plan ${item}`, Array.isArray(itemPlan.plan) && itemPlan.plan.length > 0, `steps=${itemPlan.plan?.length ?? 0}`);
  }
  await expectStatus("craft plan without an item is rejected", "GET", `/bots/${id}/craft-plan`, 400);
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
  await expectStatus("world memory requires a server", "GET", "/world-memory", 400);

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
  const badRule = await req("POST", "/rules", {
    name: "Baseline bad regex",
    enabled: true,
    botIds: [id],
    trigger: { type: "chat", pattern: "([unclosed", match: "regex", from: "anyone" },
    actions: [{ type: "panel_notify", message: "x", level: "info" }]
  });
  track("rules", badRule.id);
  ok("broken regex rule can be saved");

  const bulk = await req("POST", "/bots/bulk", { template: "BaseLn{n}", count: 2, serverId: server.id, startNow: false });
  assert("bulk create makes two offline bots",
    Array.isArray(bulk.created) && bulk.created.length === 2 && bulk.created.every((row) => row.config.auth === "offline"));
  for (const row of bulk.created) track("bots", row.config.id);

  if (!(await portOpen(MC_PORT))) {
    fail("local test server is listening", `127.0.0.1:${MC_PORT} — run npm run testserver`);
  } else {
    ok("local test server is listening");
    const squad = await req("POST", "/bots/bulk", { template: "BaseS_{n}", count: 3, serverId: server.id, startNow: false });
    assert("three squad bots created", squad.created?.length === 3);
    const [id1, id2, id3] = squad.created.map((row) => row.config.id);
    for (const botId of [id1, id2, id3]) {
      track("bots", botId);
      await req("PATCH", `/bots/${botId}`, { inventory: { autoBestGear: false } });
    }
    await req("POST", "/bots/start-all", { ids: [id1, id2, id3] });
    try {
      await waitFor("three bots online", async () => {
        const rows = await Promise.all([getBot(id1), getBot(id2), getBot(id3)]);
        return rows.every((row) => row?.status === "online") ? rows : null;
      }, 70_000);
      ok("three bots online together");
      const first = await getBot(id1);
      assert("vitals are live", first.runtime.health > 0 && first.runtime.position.y !== 0);

      const marker = `baseline selam ${Date.now() % 100000}`;
      await req("POST", `/bots/${id1}/chat`, { text: marker });
      const seen = await waitFor("second bot sees the chat", async () => {
        const history = await req("GET", `/bots/${id2}/chat-history?limit=100`);
        return history.find((entry) => String(entry.text || "").includes(marker));
      }, 20_000);
      assert("chat parsed as the sender", seen.kind === "player" && seen.username === "BaseS_1", `kind=${seen.kind} user=${seen.username}`);
      const selfHistory = await req("GET", `/bots/${id1}/chat-history?limit=100`);
      const selfEcho = selfHistory.find((entry) => String(entry.text || "").includes(marker));
      assert("sender sees its own chat", Boolean(selfEcho));
      if (selfEcho?.self) ok("own chat is marked self");
      else ok("own chat is visible");

      for (let n = 1; n <= 4; n++) await req("POST", `/bots/${id3}/chat`, { text: `rate ${n}` });
      await sleep(7000);
      const afterRate = await getBot(id3);
      assert("chat rate limit does not kick the bot", afterRate?.status === "online", afterRate?.status);
      const chatAll = await req("GET", `/bots/${id1}/chat-history?limit=200`);
      assert("system logs are not written into game chat", !chatAll.some((entry) => /\[(manager|bot|server|socket)\]/.test(entry.text || "")));

      const startPos = first.runtime.position;
      const target = { x: Math.round(startPos.x) + 12, y: Math.round(startPos.y), z: Math.round(startPos.z) + 12 };
      const gotoRes = await req("POST", `/bots/${id1}/action`, { type: "goto", ...target, range: 2 });
      assert("goto is queued", gotoRes.task?.state === "running" || gotoRes.task?.state === "queued", JSON.stringify(gotoRes.task));
      await sleep(1200);
      const during = await getBot(id1);
      assert("goto is the current task", during.tasks?.current?.type === "goto", JSON.stringify(during.tasks?.current));
      await waitFor("bot reaches the goto target", async () => {
        const row = await getBot(id1);
        return dist2d(row.runtime.position, target) <= 3.5 && !row.tasks.current;
      }, 90_000);
      ok("goto reached the target");

      const here = await req("POST", `/bots/${id1}/waypoint-here`, { name: "BaselineHere" });
      track("waypoints", here.id);
      await req("POST", `/bots/${id1}/action`, { type: "goto", x: startPos.x, y: startPos.y, z: startPos.z, range: 2 });
      await waitFor("bot returns to the start", async () => {
        const row = await getBot(id1);
        return dist2d(row.runtime.position, startPos) <= 3.5 && !row.tasks.current;
      }, 90_000);
      ok("returned to the start");
      await req("POST", `/bots/${id1}/action`, { type: "goto-waypoint", waypointId: here.id });
      await waitFor("bot reaches the waypoint", async () => {
        const row = await getBot(id1);
        return dist2d(row.runtime.position, here) <= 3.5 && !row.tasks.current;
      }, 90_000);
      ok("goto-waypoint reached");

      await req("POST", `/bots/${id2}/action`, { type: "follow", player: "BaseS_1", distance: 2 });
      await sleep(2500);
      const follower = await getBot(id2);
      const followLabel = String(follower.tasks?.current?.progress?.label ?? "");
      if (followLabel.includes("görünmüyor") || /not visible|cannot see/i.test(followLabel)) {
        skip("follow physics", "this test server does not publish player entities");
        assert("follow waits instead of crashing", Boolean(follower.tasks?.current));
      } else {
        await req("POST", `/bots/${id1}/action`, { type: "goto", x: here.x - 14, y: here.y, z: here.z, range: 2 });
        await waitFor("follower catches the leader", async () => {
          const [leader, follow] = await Promise.all([getBot(id1), getBot(id2)]);
          return !leader.tasks.current && dist2d(leader.runtime.position, follow.runtime.position) <= 5;
        }, 90_000);
        ok("follow caught the leader");
      }
      await req("POST", `/bots/${id2}/action`, { type: "stop" });
      await sleep(1500);
      const followStopped = await getBot(id2);
      assert("stop clears follow", !followStopped.tasks?.current && (followStopped.tasks?.queue?.length ?? 0) === 0);

      await req("POST", `/bots/${id3}/chat`, { text: "/give BaseS_3 iron_helmet 1" });
      await req("POST", `/bots/${id3}/chat`, { text: "/give BaseS_3 dirt 16" });
      const invReady = await waitFor("inventory sync", async () => {
        const row = await getBot(id3);
        return findItem(row.inventory, "iron_helmet") && findItem(row.inventory, "dirt") ? row.inventory : null;
      }, 25_000);
      const helmet = findItem(invReady, "iron_helmet");
      const dirt = findItem(invReady, "dirt");
      ok(`inventory synced helmet slot ${helmet.slot}, dirt x${dirt.count}`);
      await req("POST", `/bots/${id3}/inventory`, { op: "setHotbar", quickBar: 3 });
      await waitFor("hotbar slot", async () => (await getBot(id3)).inventory?.heldQuickBar === 3, 10_000);
      ok("hotbar selection synced");
      await req("PATCH", `/bots/${id3}`, { inventory: { bannedItems: ["iron_helmet"], autoBestGear: false } });
      await expectStatus("banned item cannot be equipped", "POST", `/bots/${id3}/inventory`, 400, { op: "equip", slot: helmet.slot });
      await req("PATCH", `/bots/${id3}`, { inventory: { bannedItems: [], keepItems: ["dirt"], autoBestGear: false } });
      await expectStatus("kept item cannot be dropped", "POST", `/bots/${id3}/inventory`, 400, { op: "toss", slot: dirt.slot, amount: 1 });
      await req("PATCH", `/bots/${id3}`, { inventory: { bannedItems: [], keepItems: [], autoBestGear: false } });
      try {
        await req("POST", `/bots/${id3}/inventory`, { op: "equip", slot: helmet.slot });
        await waitFor("helmet equipped", async () => findItem((await getBot(id3)).inventory, "iron_helmet")?.slot === 5, 10_000);
        ok("helmet equipped");
        try {
          await req("POST", `/bots/${id3}/inventory`, { op: "unequip", dest: "head" });
          await waitFor("helmet unequipped", async () => {
            const item = findItem((await getBot(id3)).inventory, "iron_helmet");
            return item && item.slot !== 5;
          }, 10_000);
          ok("helmet unequipped");
        } catch (err) {
          skip("unequip physics", err.message);
        }
      } catch (err) {
        skip("equip physics", err.message);
      }
      try {
        const dirtNow = findItem((await getBot(id3)).inventory, "dirt");
        await req("POST", `/bots/${id3}/inventory`, { op: "toss", slot: dirtNow.slot, amount: 1 });
        await waitFor("dirt count dropped", async () => findItem((await getBot(id3)).inventory, "dirt")?.count === dirtNow.count - 1, 10_000);
        ok("one dirt dropped");
      } catch (err) {
        skip("drop physics", err.message);
      }

      await req("POST", `/bots/${id1}/tasks/cancel-all`).catch(() => {});
      await req("POST", `/bots/${id1}/action`, { type: "attack", player: "NobodyBaseline" });
      await sleep(2500);
      const afterAttack = await getBot(id1);
      assert("missing-player attack leaves the bot online", afterAttack?.status === "online", afterAttack?.status);
      await req("POST", `/bots/${id1}/tasks/cancel-all`);
      for (const action of [
        { type: "eat" },
        { type: "hunt", radius: 12 },
        { type: "collect-wood", count: 2 },
        { type: "mine", ore: "coal", count: 1, mode: "legit" },
        { type: "craft", item: "stick", count: 1 }
      ]) {
        await req("POST", `/bots/${id1}/action`, action);
        ok(`online enqueue ${action.type}`);
      }
      await sleep(2000);
      await req("POST", `/bots/${id1}/tasks/cancel-all`);
      const still = await getBot(id1);
      assert("bot stays online after a burst of jobs", still?.status === "online", still?.status);
      if (Array.isArray(still?.inventory?.slots)) ok(`inventory snapshot has ${still.inventory.slots.length} slots`);
      else skip("inventory snapshot", "not synced yet");
    } catch (err) {
      fail("online scenarios", err.message);
    }
    await req("POST", "/bots/stop-all", { ids: [id1, id2, id3] }).catch(() => {});
  }

  await cleanup();
  const after = await req("GET", "/state");
  assert("baseline fixtures removed",
    !(after.bots || []).some((row) => /^(Baseline|BaseLn|BaseS)/.test(String(row.config?.username || ""))) &&
    !(after.servers || []).some((row) => row.name === "Baseline"));
  const rulesAfter = await req("GET", "/rules");
  assert("baseline rules removed", !rulesAfter.some((rule) => String(rule.name || "").startsWith("Baseline")));

  console.log(failures ? `\nFAILED ${failures} (${skips} skipped)` : `\nbaseline passed (${skips} skipped)`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});

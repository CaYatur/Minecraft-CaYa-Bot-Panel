/**
 * Issue #34 kabul testi: eldeki eşyayı kullanma, sunucu seçici menüsü (GUI),
 * hotbar seçimi, seçili botlara toplu işlem ve bunların MCP araçları.
 *
 * Önkoşul: `npm run start -w server` (ya da dev:server) + `npm run testserver`.
 * Test sunucusundaki test-server/server-selector.cjs, elde pusula varken sağ tıkta
 * 3 seçenekli bir menü açar ve seçilince sohbete "[selector] joined <mod>" yazar.
 */
const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
const MCP = API.replace(/\/api$/, "/mcp");
const MC_PORT = Number(process.env.CAYA_TEST_MC_PORT || 25566);

let failures = 0;
const ok = (name) => console.log(`  ok ${name}`);
const fail = (name, detail) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};
const assert = (name, cond, detail) => (cond ? ok(name) : fail(name, detail));
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

async function expectError(name, method, path, body, pattern) {
  try {
    await req(method, path, body);
    fail(name, "request succeeded");
  } catch (err) {
    assert(name, err.status >= 400 && err.status < 500 && (!pattern || pattern.test(err.message)), err.message);
  }
}

let rpcId = 1;
async function mcp(name, args = {}) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } })
  });
  const data = await res.json();
  if (data.error) return { isError: true, text: data.error.message };
  return { isError: Boolean(data.result?.isError), text: (data.result?.content ?? []).map((c) => c.text ?? "").join("\n") };
}

async function waitFor(label, fn, timeoutMs = 30_000, everyMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`${label}: not within ${timeoutMs / 1000}s`);
}

const getBot = async (id) => (await req("GET", "/state")).bots.find((b) => b.config.id === id);
const chatHas = async (id, text) => {
  const rows = await req("GET", `/bots/${id}/chat-history`);
  const list = Array.isArray(rows) ? rows : rows.entries ?? rows.items ?? [];
  return list.some((e) => JSON.stringify(e).includes(text));
};
const hasItem = async (id, name) => (await getBot(id))?.inventory?.slots?.some((s) => s && s.name === name);

async function main() {
  console.log("— issue #34 GUI + bulk test —\n");
  const NAMES = ["CaYaGui1", "CaYaGui2"];
  const pre = await req("GET", "/state");
  for (const b of pre.bots.filter((b) => NAMES.includes(b.config.username))) await req("DELETE", `/bots/${b.config.id}`).catch(() => {});
  for (const s of pre.servers.filter((s) => s.name === "GuiTest")) await req("DELETE", `/servers/${s.id}`).catch(() => {});

  const mcpBefore = (await req("GET", "/mcp")).settings;
  const server = await req("POST", "/servers", { name: "GuiTest", host: "127.0.0.1", port: MC_PORT, version: "1.16.1" });
  const ids = [];
  for (const name of NAMES) {
    const bot = await req("POST", "/bots", { username: name, serverId: server.id, startNow: false });
    await req("PATCH", `/bots/${bot.config.id}`, { inventory: { autoBestGear: false } });
    ids.push(bot.config.id);
  }
  const [a, b] = ids;

  try {
    // toplu başlat (seçili iki bot)
    const started = await req("POST", "/bots/bulk-action", { ids, action: { type: "start" } });
    assert("bulk start reports both bots", started.okCount === 2 && started.results.every((r) => r.ok), JSON.stringify(started));
    await waitFor("both bots online", async () => (await Promise.all(ids.map(getBot))).every((x) => x?.status === "online"), 60_000);
    ok("both bots online");

    await expectError("GUI click without an open window is refused", "POST", `/bots/${a}/gui`, { op: "click", slot: 11 }, /No GUI window/);
    await expectError("unknown GUI op is refused", "POST", `/bots/${a}/gui`, { op: "explode" }, /Unknown GUI operation/);
    await expectError("hotbar 9 is refused", "POST", `/bots/${a}/gui`, { op: "hotbar", hotbar: 9 }, /0-8/);
    await expectError("bulk with no bots is refused", "POST", "/bots/bulk-action", { ids: [], action: { type: "stop-work" } }, /at least one/);
    await expectError("unknown bulk action is refused", "POST", "/bots/bulk-action", { ids, action: { type: "nuke" } }, /Unknown bulk action/);

    const closedWin = await req("GET", `/bots/${a}/window`);
    assert("no window is open at first", closedWin.open === false && closedWin.slots.length === 0, JSON.stringify(closedWin));

    for (const name of NAMES) await req("POST", `/bots/${a}/chat`, { text: `/give ${name} compass 1` });
    await waitFor("compass in both inventories", async () => (await hasItem(a, "compass")) && (await hasItem(b, "compass")), 20_000);
    ok("both bots got a compass");

    // tek bot: pusulayı ele al + sağ tık → sunucu seçici
    const used = await req("POST", `/bots/${a}/gui`, { op: "use", item: "compass", waitWindowMs: 4000 });
    const win = used.result?.window;
    assert("use held item opens the server selector", used.result?.openedWindow === true && win?.open && win.title === "Server Selector", JSON.stringify(used).slice(0, 400));
    assert("held item is the compass", used.result?.used === "compass", used.result?.used);
    const one = win?.slots?.[11];
    assert("menu slot 11 shows the custom name and lore", one?.customName === "OneBlock" && one?.name === "grass_block" && one?.lore?.some((l) => l.includes("Click to join OneBlock")) && one?.section === "container", JSON.stringify(one));
    assert("menu reports 27 menu slots plus the player rows", win?.containerSlots === 27 && win?.totalSlots === 63, `${win?.containerSlots}/${win?.totalSlots}`);
    assert("player rows include the compass in the hotbar section", win?.slots?.some((s) => s && s.name === "compass" && s.section === "hotbar"));

    const live = await req("GET", `/bots/${a}/window`);
    assert("GET window matches the open menu", live.open && live.id === win.id);

    const empty = await req("POST", `/bots/${a}/gui`, { op: "click", slot: 0, windowId: win.id });
    assert("clicking an empty menu slot keeps the menu open", empty.result?.changed === "same" && empty.result?.window?.open, JSON.stringify(empty.result).slice(0, 300));

    await expectError("click with a stale window id is refused", "POST", `/bots/${a}/gui`, { op: "click", slot: 11, windowId: 9999 }, /no longer open/);

    const picked = await req("POST", `/bots/${a}/gui`, { op: "click", slot: 11, button: "left", windowId: win.id });
    assert("clicking OneBlock closes the menu", picked.result?.changed === "closed" && !picked.result?.window?.open, JSON.stringify(picked.result).slice(0, 300));
    await waitFor("server confirms the join", () => chatHas(a, "[selector] joined OneBlock"), 10_000);
    ok("server says the bot joined OneBlock");

    const hb = await req("POST", `/bots/${a}/gui`, { op: "hotbar", hotbar: 4 });
    assert("hotbar select changes the held slot", hb.hotbar === 4);
    await waitFor("inventory snapshot shows hotbar 4", async () => (await getBot(a))?.inventory?.heldQuickBar === 4, 5_000);
    ok("inventory snapshot follows the hotbar");

    // seçili botlara toplu işlem
    const bulkUse = await req("POST", "/bots/bulk-action", { ids, action: { type: "use-item", item: "compass", waitWindowMs: 4000 } });
    assert("bulk use-item opens the menu on both bots", bulkUse.okCount === 2 && bulkUse.results.every((r) => /Server Selector/.test(r.message)), JSON.stringify(bulkUse));
    const bulkClick = await req("POST", "/bots/bulk-action", { ids, action: { type: "click-slot", slot: 13 } });
    assert("bulk click-slot picks Lifesteal on both bots", bulkClick.okCount === 2 && bulkClick.results.every((r) => /closed/.test(r.message)), JSON.stringify(bulkClick));
    await waitFor("both bots joined Lifesteal", async () => (await chatHas(a, "joined Lifesteal")) && (await chatHas(b, "joined Lifesteal")), 10_000);
    ok("both bots joined Lifesteal");

    const bulkChat = await req("POST", "/bots/bulk-action", { ids, action: { type: "chat", text: "hello from {bot}" } });
    assert("bulk chat queues on both bots", bulkChat.okCount === 2 && bulkChat.results.some((r) => r.message.includes("hello from CaYaGui2")), JSON.stringify(bulkChat));
    const bulkHotbar = await req("POST", "/bots/bulk-action", { ids, action: { type: "hotbar", hotbar: 2 } });
    assert("bulk hotbar select", bulkHotbar.okCount === 2 && bulkHotbar.results.every((r) => r.message.startsWith("hotbar 2")), JSON.stringify(bulkHotbar));
    const bulkClose = await req("POST", "/bots/bulk-action", { ids, action: { type: "close-window" } });
    assert("bulk close with nothing open is harmless", bulkClose.okCount === 2 && bulkClose.results.every((r) => r.message === "no window was open"), JSON.stringify(bulkClose));
    const mixed = await req("POST", "/bots/bulk-action", { ids: [a, "missing-bot-id"], action: { type: "stop-work" } });
    assert("one missing bot does not stop the others", mixed.okCount === 1 && mixed.failCount === 1 && mixed.results[1].message === "bot not found", JSON.stringify(mixed));

    // MCP araçları
    await req("PATCH", "/mcp/settings", { enabled: true, mcpServer: { enabled: true } });
    await req("PATCH", `/mcp/bots/${a}`, { agentEnabled: true });
    const list = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/list" }) }).then((r) => r.json());
    const names = (list.result?.tools ?? []).map((t) => t.name);
    assert("MCP lists the GUI and bulk tools", ["get_open_window", "use_held_item", "select_hotbar_slot", "click_window_slot", "close_window", "bulk_action"].every((n) => names.includes(n)), names.join(","));

    const none = await mcp("get_open_window", { bot: "CaYaGui1" });
    assert("MCP get_open_window says nothing is open", !none.isError && /No window is open/.test(none.text), none.text);
    const mUse = await mcp("use_held_item", { bot: "CaYaGui1", item: "compass", waitWindowMs: 4000 });
    assert("MCP use_held_item opens the selector and lists slot 11", !mUse.isError && /Server Selector/.test(mUse.text) && /slot 11 \[container\]: "OneBlock" \(grass_block\)/.test(mUse.text), mUse.text);
    const mGet = await mcp("get_open_window", { bot: "CaYaGui1", format: "json" });
    assert("MCP get_open_window json", !mGet.isError && JSON.parse(mGet.text).open === true);
    const mClick = await mcp("click_window_slot", { bot: "CaYaGui1", slot: 15 });
    assert("MCP click_window_slot picks Survival", !mClick.isError && /Result: closed/.test(mClick.text), mClick.text);
    await waitFor("MCP join confirmed", () => chatHas(a, "joined Survival"), 10_000);
    ok("server says the bot joined Survival");
    const mHot = await mcp("select_hotbar_slot", { bot: "CaYaGui1", slot: 1 });
    assert("MCP select_hotbar_slot", !mHot.isError && /Hotbar slot 1/.test(mHot.text), mHot.text);
    const mClose = await mcp("close_window", { bot: "CaYaGui1" });
    assert("MCP close_window with nothing open", !mClose.isError && /No window was open/.test(mClose.text), mClose.text);
    const mBulk = await mcp("bulk_action", { bots: ["CaYaGui1", "CaYaGui2"], action: "hotbar", hotbar: 3 });
    assert("MCP bulk_action runs only on agent-enabled bots", !mBulk.isError && /1 ok/.test(mBulk.text) && /CaYaGui2: agent control is disabled/.test(mBulk.text), mBulk.text);
    const mTask = await mcp("bulk_action", { bots: ["*"], action: "task" });
    assert("MCP bulk_action refuses the panel-only task action", mTask.isError, mTask.text);

    const stopped = await req("POST", "/bots/bulk-action", { ids, action: { type: "stop" } });
    assert("bulk stop", stopped.okCount === 2);
    await waitFor("both bots stopped", async () => (await Promise.all(ids.map(getBot))).every((x) => x?.status === "stopped"), 15_000);
    ok("both bots stopped");

    // otomasyon (issue #34): doğunca pusulayı kullan → menüde "OneBlock" adlı eşyaya tıkla.
    // Kural MCP template_import ile kurulur; böylece şablon doğrulaması ve MCP yolu da sınanır.
    const template = {
      schema: "caya.automation-template",
      version: 1,
      name: "GuiTest join on spawn",
      description: "gui-test",
      rules: [
        {
          name: "GuiTest join on spawn",
          enabled: true,
          botIds: [b],
          trigger: { type: "bot_spawned" },
          conditions: [],
          actions: [
            { type: "send_chat", text: "/give CaYaGui2 compass 1" },
            { type: "wait", seconds: 2 },
            { type: "use_held_item", item: "compass", waitSeconds: 4 },
            { type: "click_window_slot", item: "oneblock", button: "left", waitSeconds: 4 }
          ],
          cooldownMs: 30_000
        }
      ]
    };
    const imported = await mcp("template_import", { template, apply: true });
    assert("MCP template_import accepts the menu actions", !imported.isError && /"created"/.test(imported.text), imported.text);
    const ruleIds = imported.isError ? [] : JSON.parse(imported.text).created ?? [];
    const badTpl = await mcp("template_import", { template: { ...template, rules: [{ ...template.rules[0], actions: [{ type: "click_window_slotz" }] }] } });
    assert("template_import still refuses unknown actions", badTpl.isError && /unknown action/.test(badTpl.text), badTpl.text);
    try {
      await req("POST", `/bots/${b}/start`);
      await waitFor("automation joined OneBlock on spawn", () => chatHas(b, "[selector] joined OneBlock"), 45_000);
      ok("spawn automation used the compass and joined OneBlock by item name");
    } finally {
      for (const id of ruleIds) await req("DELETE", `/rules/${id}`).catch(() => {});
      await req("POST", `/bots/${b}/stop`).catch(() => {});
    }
  } finally {
    await req("PATCH", "/mcp/settings", { enabled: mcpBefore.enabled, mcpServer: { enabled: mcpBefore.mcpServer.enabled } }).catch(() => {});
    for (const id of ids) await req("DELETE", `/bots/${id}`).catch(() => {});
    await req("DELETE", `/servers/${server.id}`).catch(() => {});
  }

  console.log(failures ? `\ngui test FAILED (${failures})` : "\ngui test passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

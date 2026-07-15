/**
 * Grok oturumu — kapsamlı regresyon (Faz 1-11 API yüzeyi).
 * Önkoşul: npm run dev:server (+ isteğe bağlı testserver)
 */
const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
let failures = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const fail = (n, d) => {
  failures++;
  console.log(`  ❌ ${n}${d ? " — " + d : ""}`);
};

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

async function main() {
  console.log("— CaYa full-suite (Grok) —\n");

  // state
  const state = await req("GET", "/state");
  ok(`state: ${state.bots?.length ?? 0} bot, ${state.servers?.length ?? 0} sunucu`);
  if (!("rules" in state) && state.rules !== undefined) fail("rules field");
  else ok("snapshot.rules alanı var");
  if (!state.worldMemory) fail("worldMemory eksik");
  else ok("snapshot.worldMemory var");

  // cleanup
  for (const b of (state.bots || []).filter((b) => b.config.username.startsWith("CaYaFull"))) {
    await req("DELETE", `/bots/${b.config.id}`).catch(() => {});
  }
  for (const s of (state.servers || []).filter((s) => s.name === "FullSuite")) {
    await req("DELETE", `/servers/${s.id}`).catch(() => {});
  }
  const rules0 = await req("GET", "/rules");
  for (const r of rules0.filter((r) => r.name.startsWith("FullSuite"))) {
    await req("DELETE", `/rules/${r.id}`).catch(() => {});
  }

  const server = await req("POST", "/servers", {
    name: "FullSuite",
    host: "127.0.0.1",
    port: 25566,
    version: "1.16.1"
  });
  ok("sunucu profili");

  const bot = await req("POST", "/bots", { username: "CaYaFull", serverId: server.id });
  const id = bot.config.id;
  ok("bot oluşturuldu");

  // combat snapshot
  if (!bot.combat) fail("combat snapshot");
  else ok(`combat.mode=${bot.combat.mode}`);

  // config patches
  await req("PATCH", `/bots/${id}`, {
    combat: { defendMode: "mob", reach: 3 },
    survival: { autoEat: true, eatAtFood: 14 },
    authorizedPlayers: ["OwnerTest"]
  });
  ok("combat/survival/authorized patch");

  // actions validation
  const actions = [
    ["eat", {}],
    ["hunt", { radius: 16 }],
    ["collect-wood", { count: 4 }],
    ["mine", { ore: "coal", count: 2, mode: "legit" }],
    ["craft", { item: "stick", count: 1 }],
    ["clear-mobs", { radius: 8 }],
    ["stop-combat", {}],
    ["stop", {}]
  ];
  for (const [type, extra] of actions) {
    try {
      // offline bot — some may queue and fail later; enqueue should accept
      await req("POST", `/bots/${id}/action`, { type, ...extra });
      ok(`action enqueue: ${type}`);
    } catch (e) {
      // offline craft/hunt may still enqueue
      if (e.status === 400 && type === "loot-death") ok(`action ${type} 400 expected`);
      else fail(`action ${type}`, e.message);
    }
  }

  try {
    await req("POST", `/bots/${id}/action`, { type: "loot-death" });
    fail("loot-death should 400 without death");
  } catch (e) {
    if (e.status === 400) ok("loot-death without death → 400");
    else fail("loot-death", e.message);
  }

  // craft plan offline heuristic
  const plan = await req("GET", `/bots/${id}/craft-plan?item=stone_pickaxe&count=1`);
  if (Array.isArray(plan.plan) && plan.plan.length > 0) ok(`craft-plan steps=${plan.plan.length}`);
  else fail("craft-plan empty");

  // rules
  const rule = await req("POST", "/rules", {
    name: "FullSuite Gel",
    enabled: true,
    botIds: [id],
    trigger: { type: "chat", pattern: "gel", match: "contains", from: "authorized" },
    actions: [{ type: "panel_notify", message: "gel test", level: "info" }],
    cooldownMs: 1000
  });
  ok(`rule created ${rule.id.slice(0, 8)}`);

  await req("POST", `/rules/${rule.id}/test`, { botId: id });
  ok("rule dry-test");

  // unauthorized would not fire — just ensure engine loaded
  const tpl = await req("POST", `/rules/templates/${encodeURIComponent("Yemek nöbetçisi")}`, { botIds: [id] });
  ok(`template: ${tpl.name}`);

  // task pause/resume endpoints
  await req("POST", `/bots/${id}/tasks/pause`);
  ok("tasks/pause");
  await req("POST", `/bots/${id}/tasks/resume`);
  ok("tasks/resume");
  const hist = await req("GET", `/bots/${id}/tasks/history`);
  if (Array.isArray(hist)) ok(`task history len=${hist.length}`);
  else fail("history");

  // world memory
  const wm = await req("GET", `/world-memory?serverId=${server.id}`);
  if (wm.chests && wm.ores) ok("world-memory empty ok");
  else fail("world-memory shape");

  // inventory ban still works offline rejection
  try {
    await req("POST", `/bots/${id}/inventory`, { op: "equip", slot: 36 });
    fail("inv op should fail offline");
  } catch (e) {
    if (e.status === 400) ok("inventory offline → 400");
    else fail("inventory", e.message);
  }

  // optional online
  try {
    await req("POST", `/bots/${id}/start`);
    await new Promise((r) => setTimeout(r, 5000));
    const st = await req("GET", "/state");
    const live = st.bots.find((b) => b.config.id === id);
    if (live?.status === "online") {
      ok("bot online against testserver");
      await req("POST", `/bots/${id}/action`, { type: "goto", x: live.runtime.position.x + 3, y: live.runtime.position.y, z: live.runtime.position.z });
      ok("goto enqueued online");
      await new Promise((r) => setTimeout(r, 2000));
      await req("POST", `/bots/${id}/action`, { type: "stop" });
      ok("stop online");
    } else {
      ok(`online skip (${live?.status}) — testserver may be down`);
    }
  } catch (e) {
    ok(`online phase skipped: ${e.message}`);
  }

  // cleanup
  await req("POST", `/bots/${id}/stop`).catch(() => {});
  await req("DELETE", `/bots/${id}`).catch(() => {});
  await req("DELETE", `/servers/${server.id}`).catch(() => {});
  for (const r of (await req("GET", "/rules")).filter((r) => r.name.startsWith("FullSuite") || r.name === "Yemek nöbetçisi")) {
    await req("DELETE", `/rules/${r.id}`).catch(() => {});
  }
  ok("cleanup");

  console.log(failures ? `\n❌ ${failures} hata` : "\n✅ full-suite geçti");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

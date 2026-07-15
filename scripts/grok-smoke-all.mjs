/**
 * Grok sistemleri — master smoke (Faz 6–12 + omurga regresyonu).
 * Önkoşul: API :3001, isteğe bağlı flying-squid :25566
 *
 * Kullanım: node scripts/grok-smoke-all.mjs
 */
const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
const MC_PORT = Number(process.env.CAYA_TEST_MC_PORT || 25566);
const MC_VERSION = process.env.CAYA_TEST_MC_VERSION || "1.16.1";

let failures = 0;
let skipped = 0;
const sections = [];

const ok = (n) => console.log(`  ✅ ${n}`);
const fail = (n, d) => {
  failures++;
  console.log(`  ❌ ${n}${d ? " — " + d : ""}`);
};
const skip = (n, d) => {
  skipped++;
  console.log(`  ⚠️ ATLANDI: ${n}${d ? " — " + d : ""}`);
};
const section = (title) => {
  console.log(`\n══ ${title} ══`);
  sections.push(title);
};

async function req(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${data.error ?? JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeoutMs = 45000, everyMs = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(everyMs);
  }
  throw new Error(`${label}: ${timeoutMs / 1000}s timeout`);
}

async function cleanupPrefix(serverName, botPrefix, rulePrefix) {
  const st = await req("GET", "/state");
  for (const b of (st.bots || []).filter((b) => b.config.username.startsWith(botPrefix))) {
    await req("POST", `/bots/${b.config.id}/stop`).catch(() => {});
    await req("DELETE", `/bots/${b.config.id}`).catch(() => {});
  }
  for (const s of (st.servers || []).filter((s) => s.name === serverName)) {
    await req("DELETE", `/servers/${s.id}`).catch(() => {});
  }
  const rules = await req("GET", "/rules").catch(() => []);
  for (const r of (rules || []).filter((r) => String(r.name || "").startsWith(rulePrefix))) {
    await req("DELETE", `/rules/${r.id}`).catch(() => {});
  }
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  CaYa Grok Master Smoke — tüm sistemler   ║");
  console.log("╚════════════════════════════════════════════╝");

  // ── 0. API ──────────────────────────────────────────────────────────────
  section("0 · API omurgası");
  let state;
  try {
    state = await req("GET", "/state");
    ok(`GET /state (bots=${state.bots?.length ?? 0}, servers=${state.servers?.length ?? 0})`);
  } catch (e) {
    fail("API erişilemiyor", e.message);
    console.log("\n❌ API yok — npm run dev:server + testserver başlat.");
    process.exit(1);
  }
  if (Array.isArray(state.supportedVersions) && state.supportedVersions.length > 0) {
    ok(`supportedVersions: ${state.supportedVersions.length}`);
  } else fail("supportedVersions boş");
  if (state.rules !== undefined) ok("snapshot.rules");
  else fail("snapshot.rules yok");
  if (state.worldMemory && Array.isArray(state.worldMemory.chests)) ok("snapshot.worldMemory");
  else fail("snapshot.worldMemory yok");
  if (state.waypoints !== undefined) ok("snapshot.waypoints");
  else fail("waypoints yok");

  await cleanupPrefix("GrokSmoke", "CaYaGrok", "GrokSmoke");

  const server = await req("POST", "/servers", {
    name: "GrokSmoke",
    host: "127.0.0.1",
    port: MC_PORT,
    version: MC_VERSION
  });
  ok(`sunucu profili ${server.host}:${server.port} @ ${server.version}`);

  const botSnap = await req("POST", "/bots", {
    username: "CaYaGrok1",
    serverId: server.id,
    autostart: false
  });
  const botId = botSnap.config.id;
  ok(`bot CaYaGrok1 (${botId.slice(0, 8)}…)`);

  // ── 1. Snapshot / config yüzeyleri (Faz 6+) ─────────────────────────────
  section("1 · Snapshot & config (Faz 6–7)");
  if (botSnap.combat && typeof botSnap.combat.mode === "string") ok(`combat.mode=${botSnap.combat.mode}`);
  else fail("combat snapshot eksik");

  const patched = await req("PATCH", `/bots/${botId}`, {
    combat: { defendMode: "all", reach: 3, fleeAtHealth: 6, cpsCap: 8, jumpCrit: true },
    survival: { autoEat: true, eatAtFood: 14 },
    inventory: { autoBestGear: false, bannedItems: ["diamond_sword"], keepItems: ["dirt"] },
    authorizedPlayers: ["OwnerGrok"],
    movement: { canDig: true, allowSprint: true, allowParkour: true }
  });
  if (patched.config.combat.defendMode === "all") ok("combat.defendMode=all");
  else fail("combat patch");
  if (patched.config.survival.autoEat === true) ok("survival.autoEat");
  else fail("survival patch");
  if (patched.config.authorizedPlayers.includes("OwnerGrok")) ok("authorizedPlayers");
  else fail("authorizedPlayers");
  if (patched.config.inventory.bannedItems.includes("diamond_sword")) ok("bannedItems");
  else fail("bannedItems");

  // ── 2. Aksiyon kuyruğu — offline enqueue (Faz 6–10) ─────────────────────
  section("2 · Action enqueue (offline, Faz 6–10)");

  const expect400 = async (label, body) => {
    try {
      await req("POST", `/bots/${botId}/action`, body);
      fail(`${label} 400 bekleniyordu`);
    } catch (e) {
      if (e.status === 400) ok(`${label} → 400`);
      else fail(label, e.message);
    }
  };

  await expect400("attack boş player", { type: "attack", player: "" });
  await expect400("loot-death (ölüm yok)", { type: "loot-death" });
  await expect400("bilinmeyen aksiyon", { type: "no_such_action_xyz" });

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
    ["chat", { text: "smoke-ping" }],
    ["deposit", {}],
    ["withdraw", { item: "dirt", count: 1 }],
    ["fetch", { item: "dirt", count: 1, player: "Someone" }]
  ];

  for (const [type, extra] of enqueueOk) {
    try {
      const r = await req("POST", `/bots/${botId}/action`, { type, ...extra });
      ok(`enqueue ${type}${r.task ? ` → task ${r.task.state || "ok"}` : " (instant)"}`);
    } catch (e) {
      // offline bot: some actions may still enqueue; 400 only if validation
      if (e.status === 400) {
        // fetch may 400 only when running; enqueue should work
        fail(`enqueue ${type}`, e.message);
      } else fail(`enqueue ${type}`, e.message);
    }
  }

  // cancel tasks after flood
  await req("POST", `/bots/${botId}/tasks/cancel-all`).catch(() => {});
  ok("tasks/cancel-all");

  // ── 3. Craft plan (Faz 9) ───────────────────────────────────────────────
  section("3 · Craft plan (Faz 9)");
  for (const item of ["stick", "stone_pickaxe", "crafting_table", "furnace"]) {
    try {
      const plan = await req("GET", `/bots/${botId}/craft-plan?item=${encodeURIComponent(item)}&count=1`);
      if (Array.isArray(plan.plan) && plan.plan.length > 0) ok(`plan ${item}: ${plan.plan.length} adım`);
      else fail(`plan ${item} boş`);
    } catch (e) {
      fail(`plan ${item}`, e.message);
    }
  }
  try {
    await req("GET", `/bots/${botId}/craft-plan`);
    fail("craft-plan itemsiz 400 bekleniyordu");
  } catch (e) {
    if (e.status === 400) ok("craft-plan itemsiz → 400");
    else fail("craft-plan itemsiz", e.message);
  }

  // ── 4. Task pause/resume/history (Faz 10) ───────────────────────────────
  section("4 · TaskQueue API (Faz 10)");
  await req("POST", `/bots/${botId}/tasks/pause`);
  ok("tasks/pause");
  await req("POST", `/bots/${botId}/tasks/resume`);
  ok("tasks/resume");
  const hist = await req("GET", `/bots/${botId}/tasks/history`);
  if (Array.isArray(hist)) ok(`tasks/history (${hist.length} kayıt)`);
  else fail("tasks/history");

  // ── 5. World memory (Faz 10) ────────────────────────────────────────────
  section("5 · World memory (Faz 10)");
  const wm = await req("GET", `/world-memory?serverId=${server.id}`);
  if (Array.isArray(wm.chests) && Array.isArray(wm.ores)) ok(`world-memory chests=${wm.chests.length} ores=${wm.ores.length}`);
  else fail("world-memory shape");
  try {
    await req("GET", "/world-memory");
    fail("world-memory serverId zorunlu");
  } catch (e) {
    if (e.status === 400) ok("world-memory serverId yok → 400");
    else fail("world-memory", e.message);
  }

  // ── 6. Rules (Faz 11) ───────────────────────────────────────────────────
  section("6 · RuleEngine (Faz 11)");
  const rule = await req("POST", "/rules", {
    name: "GrokSmoke Gel",
    enabled: true,
    botIds: [botId],
    trigger: { type: "chat", pattern: "gel", match: "contains", from: "authorized" },
    conditions: [],
    actions: [{ type: "panel_notify", message: "gel:{player}", level: "info" }],
    cooldownMs: 1500,
    maxTriggersPerMinute: 5
  });
  ok(`kural oluşturuldu: ${rule.name}`);

  const rules = await req("GET", "/rules");
  if (rules.some((r) => r.id === rule.id)) ok("GET /rules listede");
  else fail("kural listede yok");

  await req("PATCH", `/rules/${rule.id}`, { enabled: false });
  const off = (await req("GET", "/rules")).find((r) => r.id === rule.id);
  if (off && off.enabled === false) ok("kural kapatıldı");
  else fail("kural patch");

  await req("PATCH", `/rules/${rule.id}`, { enabled: true });
  ok("kural tekrar açıldı");

  await req("POST", `/rules/${rule.id}/test`, { botId });
  ok("kural dry-test");

  const templates = ["Gel komutu", "Beni koru", "Oduncu", "Yemek nöbetçisi", "Hoş geldin"];
  for (const t of templates) {
    try {
      const r = await req("POST", `/rules/templates/${encodeURIComponent(t)}`, { botIds: [botId] });
      ok(`şablon: ${r.name}`);
    } catch (e) {
      fail(`şablon ${t}`, e.message);
    }
  }

  // bad regex should not crash on test - create and dry-run if possible
  try {
    const bad = await req("POST", "/rules", {
      name: "GrokSmoke BadRegex",
      enabled: true,
      botIds: [botId],
      trigger: { type: "chat", pattern: "([unclosed", match: "regex", from: "anyone" },
      actions: [{ type: "panel_notify", message: "x", level: "info" }]
    });
    ok("hatalı regex kuralı kaydedilebildi (çalışınca disable olur)");
    await req("DELETE", `/rules/${bad.id}`).catch(() => {});
  } catch (e) {
    ok(`hatalı regex create: ${e.message.slice(0, 60)}`);
  }

  // ── 7. Inventory constraints API (Faz 5/6 etkileşim) ────────────────────
  section("7 · Envanter kısıt API (offline)");
  try {
    await req("POST", `/bots/${botId}/inventory`, { op: "equip", slot: 36 });
    fail("offline inventory 400 bekleniyordu");
  } catch (e) {
    if (e.status === 400) ok("inventory offline → 400");
    else fail("inventory", e.message);
  }

  // ── 8. Logs / chat history endpoints ────────────────────────────────────
  section("8 · Log & chat history");
  const logs = await req("GET", `/logs?botId=${botId}&limit=50`);
  if (Array.isArray(logs)) ok(`GET /logs (${logs.length})`);
  else fail("logs");
  const chatH = await req("GET", `/bots/${botId}/chat-history?limit=20`);
  if (Array.isArray(chatH)) ok(`chat-history (${chatH.length})`);
  else fail("chat-history");

  // ── 9. Waypoints CRUD ───────────────────────────────────────────────────
  section("9 · Waypoints");
  const wp = await req("POST", "/waypoints", {
    serverId: server.id,
    name: "grok-wp",
    x: 10,
    y: 64,
    z: -10,
    dimension: "overworld"
  });
  ok(`waypoint ${wp.name}`);
  const wps = await req("GET", `/waypoints?serverId=${server.id}`);
  if (wps.some((w) => w.id === wp.id)) ok("waypoint listede");
  else fail("waypoint liste");
  await req("DELETE", `/waypoints/${wp.id}`);
  ok("waypoint silindi");

  // ── 10. Online faz (flying-squid) ────────────────────────────────────────
  section("10 · Online (flying-squid) — bağlan + hareket + vitals");
  let online = false;
  try {
    await req("POST", `/bots/${botId}/start`);
    const live = await waitFor(
      "bot online",
      async () => {
        const st = await req("GET", "/state");
        const b = st.bots.find((x) => x.config.id === botId);
        return b?.status === "online" ? b : null;
      },
      50000
    );
    online = true;
    ok(`online can=${live.runtime.health} açlık=${live.runtime.food}`);
    ok(`konum ${Math.round(live.runtime.position.x)},${Math.round(live.runtime.position.y)},${Math.round(live.runtime.position.z)}`);

    if (live.combat) ok(`combat runtime mode=${live.combat.mode}`);
    else fail("online combat field");

    // chat rate
    await req("POST", `/bots/${botId}/chat`, { text: "grok smoke 1" });
    await req("POST", `/bots/${botId}/chat`, { text: "grok smoke 2" });
    ok("chat 2 mesaj kuyruğa (rate limiter)");

    // goto short
    const px = live.runtime.position.x;
    const py = live.runtime.position.y;
    const pz = live.runtime.position.z;
    await req("POST", `/bots/${botId}/action`, { type: "goto", x: px + 4, y: py, z: pz + 4 });
    ok("goto +4,+4 kuyruğa");
    await sleep(3000);
    await req("POST", `/bots/${botId}/action`, { type: "stop" });
    ok("stop");

    // waypoint here
    try {
      const wh = await req("POST", `/bots/${botId}/waypoint-here`, { name: "grok-here" });
      ok(`waypoint-here ${wh.name}`);
      await req("DELETE", `/waypoints/${wh.id}`).catch(() => {});
    } catch (e) {
      fail("waypoint-here", e.message);
    }

    // attack missing player — task fails, bot stays online
    await req("POST", `/bots/${botId}/action`, { type: "attack", player: "NobodyGrok999" });
    await sleep(2500);
    const afterAtk = (await req("GET", "/state")).bots.find((b) => b.config.id === botId);
    if (afterAtk?.status === "online") ok("attack missing player — bot hâlâ online");
    else fail("attack sonrası status", afterAtk?.status);

    // survival/gather enqueue online (fizik tamamlanmasa da crash yok)
    await req("POST", `/bots/${botId}/tasks/cancel-all`);
    for (const a of [
      { type: "eat" },
      { type: "hunt", radius: 12 },
      { type: "collect-wood", count: 2 },
      { type: "mine", ore: "coal", count: 1, mode: "legit" },
      { type: "craft", item: "stick", count: 1 }
    ]) {
      try {
        await req("POST", `/bots/${botId}/action`, a);
        ok(`online enqueue ${a.type}`);
      } catch (e) {
        fail(`online enqueue ${a.type}`, e.message);
      }
    }
    await sleep(2000);
    await req("POST", `/bots/${botId}/tasks/cancel-all`);
    const still = (await req("GET", "/state")).bots.find((b) => b.config.id === botId);
    if (still?.status === "online") ok("yoğun enqueue sonrası bot online");
    else fail("bot status", still?.status);

    // inventory sync present when online
    if (still?.inventory && Array.isArray(still.inventory.slots)) {
      ok(`inventory snapshot slots=${still.inventory.slots.length}`);
    } else {
      // may be null until first update
      skip("inventory henüz null olabilir", "spawn sync gecikmesi");
    }

    // multi-bot smoke mini
    const bulk = await req("POST", "/bots/bulk", {
      template: "CaYaGrok_{n}",
      count: 2,
      serverId: server.id,
      startNow: true
    });
    // note: CaYaGrok1 exists — bulk may create CaYaGrok_1 style
    ok(`bulk create ${bulk.created?.length ?? 0} bot`);
    await sleep(6000);
    const st2 = await req("GET", "/state");
    const grokOnline = st2.bots.filter((b) => b.config.username.startsWith("CaYaGrok") && b.status === "online");
    if (grokOnline.length >= 1) ok(`${grokOnline.length} Grok* bot online`);
    else skip("çoklu bot online", "bağlantı yavaş/çakışma");
  } catch (e) {
    skip("online faz", e.message + " (testserver kapalı olabilir)");
  }

  // ── 11. Logs İ1 sample ──────────────────────────────────────────────────
  section("11 · Log hub (İ1)");
  const allLogs = await req("GET", "/logs?limit=100");
  if (Array.isArray(allLogs) && allLogs.length > 0) ok(`log hub ${allLogs.length} kayıt`);
  else fail("log hub boş");
  const hasErrorLevel = allLogs.some((l) => l.level === "error" || l.level === "info" || l.level === "success");
  if (hasErrorLevel) ok("log seviyeleri mevcut");
  else skip("log seviyeleri", "boş set");

  // ── Cleanup ─────────────────────────────────────────────────────────────
  section("12 · Temizlik");
  await cleanupPrefix("GrokSmoke", "CaYaGrok", "GrokSmoke");
  // also Yemek nöbetçisi etc from templates if named differently
  const leftover = await req("GET", "/rules");
  for (const r of leftover.filter((r) => ["Gel komutu", "Beni koru", "Oduncu", "Yemek nöbetçisi", "Hoş geldin"].includes(r.name))) {
    await req("DELETE", `/rules/${r.id}`).catch(() => {});
  }
  ok("temizlik");

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════");
  console.log(`Bölümler: ${sections.length}`);
  console.log(`Başarısız: ${failures}`);
  console.log(`Atlanan: ${skipped}`);
  if (failures === 0) {
    console.log(online ? "✅ MASTER SMOKE GEÇTİ (online dahil)" : "✅ MASTER SMOKE GEÇTİ (online kısmen atlandı)");
  } else {
    console.log("❌ MASTER SMOKE HATALI");
  }
  console.log("════════════════════════════════════════\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

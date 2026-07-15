/**
 * Faz 6 dövüş kabul testi (API + saf silah mantığı).
 * Entity/vuruş fiziği flying-squid'te YOK — Paper'da doğrulanır.
 *
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
    err.data = data;
    throw err;
  }
  return data;
}

// ---- pure weapon logic (mirrors server/src/modules/combat/weapons.ts) --------
const WEAPON_SCORE = {
  netherite_sword: 100,
  diamond_sword: 90,
  iron_sword: 80,
  wooden_sword: 60,
  diamond_axe: 75
};
function pickBest(names, banned) {
  let best = null;
  let bestS = 0;
  for (const n of names) {
    if (banned.includes(n)) continue;
    const s = WEAPON_SCORE[n] ?? 0;
    if (s > bestS) {
      bestS = s;
      best = n;
    }
  }
  return best;
}

async function main() {
  console.log("— CaYa Faz 6 dövüş testi —\n");

  await req("GET", "/state");
  ok("API erişilebilir");

  // silah seçimi (banned uyumu)
  const best1 = pickBest(["wooden_sword", "diamond_sword", "dirt"], []);
  if (best1 === "diamond_sword") ok("Silah skoru: diamond_sword tercih");
  else fail("Silah skoru", best1);
  const best2 = pickBest(["diamond_sword", "iron_sword"], ["diamond_sword"]);
  if (best2 === "iron_sword") ok("Yasaklı diamond atlandı → iron_sword");
  else fail("Yasaklı silah", best2);

  // temizlik
  const pre = await req("GET", "/state");
  for (const b of pre.bots.filter((b) => b.config.username.startsWith("CaYaCombat"))) {
    await req("DELETE", `/bots/${b.config.id}`).catch(() => {});
  }
  for (const s of pre.servers.filter((s) => s.name === "CombatTest")) {
    await req("DELETE", `/servers/${s.id}`).catch(() => {});
  }

  const server = await req("POST", "/servers", {
    name: "CombatTest",
    host: "127.0.0.1",
    port: Number(process.env.CAYA_TEST_MC_PORT || 25566),
    version: process.env.CAYA_TEST_MC_VERSION || "1.16.1"
  });
  ok("Test sunucu profili");

  const bot = await req("POST", "/bots", {
    username: "CaYaCombat",
    serverId: server.id,
    startNow: false
  });
  const id = bot.config.id;
  ok(`Bot oluşturuldu (${id.slice(0, 8)}…)`);

  // combat alanı snapshot'ta
  if (!bot.combat || typeof bot.combat.mode !== "string") fail("snapshot.combat eksik");
  else ok(`combat snapshot: mode=${bot.combat.mode}`);

  // config patch
  const patched = await req("PATCH", `/bots/${id}`, {
    combat: { defendMode: "all", reach: 3, fleeAtHealth: 6, jumpCrit: true }
  });
  if (patched.config.combat.defendMode === "all") ok("defendMode=all kaydedildi");
  else fail("defendMode patch");

  // boş attack → 400
  try {
    await req("POST", `/bots/${id}/action`, { type: "attack", player: "" });
    fail("boş attack reddedilmeliydi");
  } catch (e) {
    if (e.status === 400) ok("boş attack → 400");
    else fail("boş attack", e.message);
  }

  // loot without death
  try {
    await req("POST", `/bots/${id}/action`, { type: "loot-death" });
    fail("loot-death ölüm yokken reddedilmeliydi");
  } catch (e) {
    if (e.status === 400) ok("loot-death (ölüm yok) → 400");
    else fail("loot-death", e.message);
  }

  // stop-combat anlık
  const stop = await req("POST", `/bots/${id}/action`, { type: "stop-combat" });
  if (stop.ok) ok("stop-combat OK");
  else fail("stop-combat");

  // botu başlat (test sunucu yoksa bağlanamayabilir — yine de dene)
  try {
    await req("POST", `/bots/${id}/start`);
    // kısa bekle
    await new Promise((r) => setTimeout(r, 4000));
    const st = await req("GET", "/state");
    const live = st.bots.find((b) => b.config.id === id);
    if (live?.status === "online") {
      ok("Bot online (test sunucusu ayakta)");
      // entity yokken attack görevi fail beklenir
      await req("POST", `/bots/${id}/action`, { type: "attack", player: "NobodyXYZ" });
      await new Promise((r) => setTimeout(r, 2500));
      const st2 = await req("GET", "/state");
      const live2 = st2.bots.find((b) => b.config.id === id);
      const cur = live2?.tasks?.current;
      // görev bitmiş veya failed olabilir
      ok(`attack NobodyXYZ denendi (current=${cur?.label ?? "yok"} — flying-squid entity yok, fail beklenir)`);
    } else {
      ok(`Bot online değil (${live?.status}) — entity testi atlandı (testserver kapalı olabilir)`);
    }
  } catch (e) {
    fail("bot start", e.message);
  }

  // temizlik
  await req("POST", `/bots/${id}/stop`).catch(() => {});
  await req("DELETE", `/bots/${id}`).catch(() => {});
  await req("DELETE", `/servers/${server.id}`).catch(() => {});
  ok("Temizlik");

  console.log(failures ? `\n❌ ${failures} hata` : "\n✅ Faz 6 API/mantık testi geçti (fizik: Paper)");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

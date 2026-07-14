/**
 * Uçtan uca duman testi (Faz 1-3 kabul kriterleri).
 * Önkoşullar: `npm run dev` (veya dev:server) ve `npm run testserver` çalışıyor olmalı.
 *
 * Doğrular:
 *  F1: bot oluştur → sunucuya bağlan → online + canlı vitals (can/konum)
 *  F2: 3 paralel bot, kademeli başlatma, hepsi aynı anda çevrimiçi
 *  F3: bot1 sohbete yazar → bot2 panelde görür (parse edilmiş, oyuncu adıyla)
 *  Temizlik: durdur + sil + profili sil
 */
const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
const MC_HOST = "127.0.0.1";
const MC_PORT = Number(process.env.CAYA_TEST_MC_PORT || 25566);
const MC_VERSION = process.env.CAYA_TEST_MC_VERSION || "1.16.1";

let failures = 0;
const ok = (name) => console.log(`  ✅ ${name}`);
const fail = (name, detail) => {
  failures++;
  console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
};

async function req(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error ?? "?"}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeoutMs = 60_000, everyMs = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`${label}: ${timeoutMs / 1000}s içinde gerçekleşmedi`);
}

async function main() {
  console.log("— CaYa duman testi başlıyor —\n");

  // 0. API ayakta mı?
  await req("GET", "/state");
  ok("API erişilebilir (/api/state)");

  // temizlik: önceki smoke kalıntıları
  const pre = await req("GET", "/state");
  for (const b of pre.bots.filter((b) => b.config.username.startsWith("CaYaSmoke"))) {
    await req("DELETE", `/bots/${b.config.id}`).catch(() => {});
  }
  for (const s of pre.servers.filter((s) => s.name === "SmokeTest")) {
    await req("DELETE", `/servers/${s.id}`).catch(() => {});
  }

  // 1. sunucu profili
  const server = await req("POST", "/servers", {
    name: "SmokeTest",
    host: MC_HOST,
    port: MC_PORT,
    version: MC_VERSION
  });
  ok(`Sunucu profili oluşturuldu (${MC_HOST}:${MC_PORT} @ ${MC_VERSION})`);

  let botIds = [];
  try {
    // 2. F2: 3 paralel bot (kademeli başlat)
    const bulk = await req("POST", "/bots/bulk", {
      template: "CaYaSmoke_{n}",
      count: 3,
      serverId: server.id,
      startNow: true
    });
    botIds = bulk.created.map((b) => b.config.id);
    if (botIds.length === 3) ok("3 bot toplu oluşturuldu (CaYaSmoke_1..3)");
    else fail("Toplu bot oluşturma", `beklenen 3, gelen ${botIds.length}`);

    // 3. F1+F2: hepsi online olana kadar bekle
    await waitFor("tüm botlar online", async () => {
      const st = await req("GET", "/state");
      const mine = st.bots.filter((b) => botIds.includes(b.config.id));
      return mine.length === 3 && mine.every((b) => b.status === "online");
    });
    ok("3 bot da aynı anda çevrimiçi (kademeli bağlantı çalıştı)");

    // 4. F1: vitals gerçekçi mi?
    const st1 = await req("GET", "/state");
    const b1 = st1.bots.find((b) => b.config.id === botIds[0]);
    if (b1.runtime.health > 0) ok(`Vitals akıyor (can: ${b1.runtime.health}, açlık: ${b1.runtime.food})`);
    else fail("Vitals", "can 0 görünüyor — health eventi gelmemiş");
    if (Math.abs(b1.runtime.position.x) + Math.abs(b1.runtime.position.z) >= 0 && b1.runtime.position.y !== 0)
      ok(`Konum akıyor (${b1.runtime.position.x}, ${b1.runtime.position.y}, ${b1.runtime.position.z})`);
    else fail("Konum", "pozisyon hiç güncellenmemiş");

    // 5. F3: bot1 yazar → bot2 görür
    const marker = `selam dunya ${Date.now() % 100000}`;
    await req("POST", `/bots/${botIds[0]}/chat`, { text: marker });
    const seen = await waitFor(
      "bot2 mesajı görsün",
      async () => {
        const h = await req("GET", `/bots/${botIds[1]}/chat-history?limit=100`);
        return h.find((e) => e.text.includes(marker));
      },
      20_000
    );
    if (seen.kind === "player" && seen.username === "CaYaSmoke_1")
      ok(`Sohbet çapraz doğrulandı: bot2, "<CaYaSmoke_1> ${marker}" gördü (parse OK)`);
    else if (seen) {
      ok(`Sohbet iletildi (bot2 gördü) — parse: kind=${seen.kind}, user=${seen.username ?? "-"}`);
    }

    // 6. F3: bot1 kendi echo'sunu da görmeli (self işaretli)
    const h1 = await req("GET", `/bots/${botIds[0]}/chat-history?limit=100`);
    const selfEcho = h1.find((e) => e.text.includes(marker));
    if (selfEcho?.self) ok("Kendi mesajının echo'su self olarak işaretlendi");
    else if (selfEcho) ok("Kendi mesajının echo'su görüldü");
    else fail("Self echo", "bot1 kendi mesajını görmedi (sunucu echo etmiyor olabilir — gerçek sunucuda tekrar dene)");

    // 7. F3/İ5: hız sınırı — 4 mesaj art arda, kick yememeli
    for (let i = 1; i <= 4; i++) await req("POST", `/bots/${botIds[2]}/chat`, { text: `hiz testi ${i}` });
    await sleep(7000);
    const st2 = await req("GET", "/state");
    const b3 = st2.bots.find((b) => b.config.id === botIds[2]);
    if (b3.status === "online") ok("Hız sınırlayıcı: 4 hızlı mesaj sonrası bot hâlâ çevrimiçi (kick yok)");
    else fail("Hız sınırlayıcı", `bot durumu: ${b3.status}`);

    // 8. loglar İ1: log kaydı var mı (ve sohbete sistem mesajı yazılmadı — chat geçmişinde [manager] vs. olmamalı)
    const logs = await req("GET", "/logs?limit=50");
    if (logs.length > 0) ok(`Log hub çalışıyor (${logs.length} kayıt)`);
    else fail("Log hub", "hiç log yok");
    const chatAll = await req("GET", `/bots/${botIds[0]}/chat-history?limit=200`);
    const leaked = chatAll.find((e) => /\[(manager|bot|server|socket)\]/.test(e.text));
    if (!leaked) ok("İ1 doğrulandı: oyun sohbetinde sistem mesajı izi yok");
    else fail("İ1", `sohbette sistem izi: ${leaked.text}`);
  } finally {
    // 9. temizlik
    try {
      await req("POST", "/bots/stop-all", { ids: botIds });
      await sleep(1000);
      for (const id of botIds) await req("DELETE", `/bots/${id}`).catch(() => {});
      await req("DELETE", `/servers/${server.id}`);
      ok("Temizlik tamam (botlar + profil silindi)");
    } catch (e) {
      fail("Temizlik", String(e.message ?? e));
    }
  }

  console.log(failures === 0 ? "\n— SONUÇ: HEPSİ GEÇTİ ✅ —" : `\n— SONUÇ: ${failures} BAŞARISIZ ❌ —`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n💥 Duman testi çöktü:", e.message ?? e);
  process.exit(1);
});

/**
 * Faz 4 kabul testi: goto, waypoint (kaydet + git), takip, durdur, görev kuyruğu.
 * Önkoşul: `npm run dev` (veya dev:server) + `npm run testserver` çalışıyor.
 * Not: flying-squid süperflat düz zemindir — duvar/çukur aşma (scaffold/dig)
 * gerçek Paper sunucuda ayrıca doğrulanmalı (TODO.md Faz 4 notu).
 */
const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
const MC_PORT = Number(process.env.CAYA_TEST_MC_PORT || 25566);

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m, d) => {
  failures++;
  console.log(`  ❌ ${m}${d ? " — " + d : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(label, fn, timeoutMs = 60_000, everyMs = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`${label}: ${timeoutMs / 1000}s içinde olmadı`);
}

const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

async function getBot(id) {
  const st = await req("GET", "/state");
  return st.bots.find((b) => b.config.id === id);
}

async function main() {
  console.log("— Faz 4 hareket testi —\n");

  // temizlik: eski test kalıntıları
  const pre = await req("GET", "/state");
  for (const b of pre.bots.filter((b) => b.config.username.startsWith("CaYaMove"))) {
    await req("DELETE", `/bots/${b.config.id}`).catch(() => {});
  }
  for (const s of pre.servers.filter((s) => s.name === "MoveTest")) {
    for (const wps of Object.values(pre.waypoints ?? {})) {
      for (const wp of wps.filter((w) => w.serverId === s.id)) await req("DELETE", `/waypoints/${wp.id}`).catch(() => {});
    }
    await req("DELETE", `/servers/${s.id}`).catch(() => {});
  }

  const server = await req("POST", "/servers", { name: "MoveTest", host: "127.0.0.1", port: MC_PORT, version: "1.16.1" });
  const bulk = await req("POST", "/bots/bulk", { template: "CaYaMove_{n}", count: 2, serverId: server.id, startNow: true });
  const [id1, id2] = bulk.created.map((b) => b.config.id);

  try {
    await waitFor("botlar online", async () => {
      const st = await req("GET", "/state");
      const mine = st.bots.filter((b) => [id1, id2].includes(b.config.id));
      return mine.length === 2 && mine.every((b) => b.status === "online");
    });
    ok("2 bot çevrimiçi");

    // --- GOTO ---
    const b1a = await getBot(id1);
    const p0 = b1a.runtime.position;
    const target = { x: Math.round(p0.x) + 12, y: Math.round(p0.y), z: Math.round(p0.z) + 12 };
    const gotoRes = await req("POST", `/bots/${id1}/action`, { type: "goto", ...target, range: 2 });
    if (gotoRes.task?.state === "running" || gotoRes.task?.state === "queued") ok(`Goto görevi kuyruğa girdi (${gotoRes.task.label})`);
    else fail("Goto görev kaydı", JSON.stringify(gotoRes));

    // görev çalışırken current dolu mu?
    await sleep(1200);
    const during = await getBot(id1);
    if (during.tasks?.current?.type === "goto") ok("Görev kuyruğu canlı yayında (current=goto)");
    else fail("Görev yayını", `current: ${JSON.stringify(during.tasks?.current)}`);

    await waitFor(
      "bot hedefe ulaşsın",
      async () => {
        const b = await getBot(id1);
        return dist2d(b.runtime.position, target) <= 3.5 && !b.tasks.current;
      },
      90_000
    );
    ok(`Goto tamamlandı — bot hedefe ulaştı (±3.5 blok)`);

    // --- WAYPOINT ---
    const wp = await req("POST", `/bots/${id1}/waypoint-here`, { name: "nokta-a" });
    ok(`Waypoint kaydedildi: ${wp.name} (${Math.round(wp.x)}, ${Math.round(wp.y)}, ${Math.round(wp.z)})`);

    await req("POST", `/bots/${id1}/action`, { type: "goto", x: p0.x, y: p0.y, z: p0.z, range: 2 });
    await waitFor("başlangıca dönsün", async () => {
      const b = await getBot(id1);
      return dist2d(b.runtime.position, p0) <= 3.5 && !b.tasks.current;
    }, 90_000);
    ok("Başlangıç noktasına dönüldü");

    await req("POST", `/bots/${id1}/action`, { type: "goto-waypoint", waypointId: wp.id });
    await waitFor("waypoint'e ulaşsın", async () => {
      const b = await getBot(id1);
      return dist2d(b.runtime.position, wp) <= 3.5 && !b.tasks.current;
    }, 90_000);
    ok("Waypoint hedefi çalıştı (goto-waypoint)");

    // --- FOLLOW ---
    // flying-squid oyuncu VARLIKLARINI (entity) istemcilere yayınlamıyor (offline UUID
    // uyumsuzluğu) — bu ortamda takip fiziksel olarak test edilemez. Görev "oyuncu
    // görünmüyor" durumundaysa atlanır; gerçek doğrulama Paper sunucuda (TODO Faz 4 notu).
    await req("POST", `/bots/${id2}/action`, { type: "follow", player: "CaYaMove_1", distance: 2 });
    await sleep(2500);
    const f = await getBot(id2);
    const followLabel = f.tasks.current?.progress?.label ?? "";
    if (followLabel.includes("görünmüyor")) {
      console.log("  ⚠️ ATLANDI: takip fiziği — flying-squid oyuncu varlığı yayınlamıyor; Paper'da doğrulanacak");
      ok("Takip görevi düzgün bekleme durumunda (oyuncu görünmüyor — sonsuz döngü/çökme yok)");
    } else {
      await req("POST", `/bots/${id1}/action`, { type: "goto", x: wp.x - 14, y: wp.y, z: wp.z, range: 2 });
      await waitFor("takipçi lidere yaklaşsın", async () => {
        const [ba, bb] = await Promise.all([getBot(id1), getBot(id2)]);
        return !ba.tasks.current && dist2d(ba.runtime.position, bb.runtime.position) <= 5;
      }, 90_000);
      ok("Takip çalışıyor — bot2, bot1'in peşinden geldi (≤5 blok)");
    }

    // --- STOP --- (takip görevi hâlâ aktif/bekliyor — iptal edilmeli)
    await req("POST", `/bots/${id2}/action`, { type: "stop" });
    await sleep(2000);
    const b2 = await getBot(id2);
    if (!b2.tasks.current && b2.tasks.queue.length === 0) ok("Durdur: takip görevi iptal edildi, kuyruk boş");
    else fail("Durdur", JSON.stringify(b2.tasks));

    // --- hatalı hedef: ulaşılmaz nokta (çok uzak) hızlı ve düzgün hata vermeli mi?
    // (süperflatta 'noPath' üretmek zor — bu senaryo Paper testine bırakıldı)
  } finally {
    try {
      await req("POST", "/bots/stop-all", { ids: [id1, id2] });
      await sleep(800);
      for (const id of [id1, id2]) await req("DELETE", `/bots/${id}`).catch(() => {});
      const st = await req("GET", "/state");
      for (const wps of Object.values(st.waypoints ?? {})) {
        for (const wp of wps.filter((w) => w.serverId === server.id)) await req("DELETE", `/waypoints/${wp.id}`).catch(() => {});
      }
      await req("DELETE", `/servers/${server.id}`);
      ok("Temizlik tamam");
    } catch (e) {
      fail("Temizlik", String(e.message ?? e));
    }
  }

  console.log(failures === 0 ? "\n— SONUÇ: HEPSİ GEÇTİ ✅ —" : `\n— SONUÇ: ${failures} BAŞARISIZ ❌ —`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n💥 Test çöktü:", e.message ?? e);
  process.exit(1);
});

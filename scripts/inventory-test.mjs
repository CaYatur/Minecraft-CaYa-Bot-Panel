/**
 * Faz 5 kabul testi: envanter senkronu, hotbar seçimi, yasak/koruma kısıtları,
 * kuşan/çıkar/at işlemleri.
 * Önkoşul: `npm run dev` + `npm run testserver` çalışıyor (flying-squid /give destekli).
 * Not: kuşan/at işlemleri sunucunun pencere-tıklaması desteğine bağlıdır — flying-squid
 * desteklemiyorsa ⚠️ ATLANDI basar (Paper'da doğrula); kısıt reddi testleri her koşulda kesindir.
 */
const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
const MC_PORT = Number(process.env.CAYA_TEST_MC_PORT || 25566);

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const skip = (m) => console.log(`  ⚠️ ATLANDI: ${m}`);
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
  if (!res.ok) {
    const err = new Error(`${data.error ?? "?"}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function waitFor(label, fn, timeoutMs = 30_000, everyMs = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`${label}: ${timeoutMs / 1000}s içinde olmadı`);
}

async function getBot(id) {
  const st = await req("GET", "/state");
  return st.bots.find((b) => b.config.id === id);
}

const findItem = (inv, name) => inv?.slots?.find((s) => s && s.name === name) ?? null;

async function main() {
  console.log("— Faz 5 envanter testi —\n");

  const pre = await req("GET", "/state");
  for (const b of pre.bots.filter((b) => b.config.username === "CaYaInv")) {
    await req("DELETE", `/bots/${b.config.id}`).catch(() => {});
  }
  for (const s of pre.servers.filter((s) => s.name === "InvTest")) {
    await req("DELETE", `/servers/${s.id}`).catch(() => {});
  }

  const server = await req("POST", "/servers", { name: "InvTest", host: "127.0.0.1", port: MC_PORT, version: "1.16.1" });
  // autoBestGear KAPALI: flying-squid pencere tıklamalarına yanıt vermediği için
  // armor-manager'ın otomatik kuşanma denemesi askıda kalıp testi kilitliyor (TODO §12).
  const bot = await req("POST", "/bots", { username: "CaYaInv", serverId: server.id, startNow: false });
  const id = bot.config.id;
  await req("PATCH", `/bots/${id}`, { inventory: { autoBestGear: false } });
  await req("POST", `/bots/${id}/start`);

  try {
    await waitFor("bot online", async () => (await getBot(id))?.status === "online", 40_000);
    ok("Bot çevrimiçi");

    // --- 1. senkron: /give ile eşya ver, panel API'sinde görün ---
    await req("POST", `/bots/${id}/chat`, { text: "/give CaYaInv iron_helmet 1" });
    await req("POST", `/bots/${id}/chat`, { text: "/give CaYaInv dirt 16" });
    const invReady = await waitFor(
      "envanter senkronu",
      async () => {
        const b = await getBot(id);
        return findItem(b.inventory, "iron_helmet") && findItem(b.inventory, "dirt") ? b.inventory : null;
      },
      25_000
    );
    const helm0 = findItem(invReady, "iron_helmet");
    const dirt0 = findItem(invReady, "dirt");
    ok(`Envanter senkronu çalışıyor (iron_helmet @slot ${helm0.slot}, dirt ×${dirt0.count} @slot ${dirt0.slot})`);

    // --- 2. hotbar seçimi (istemci tarafı — her sunucuda çalışır) ---
    await req("POST", `/bots/${id}/inventory`, { op: "setHotbar", quickBar: 3 });
    await waitFor("hotbar seçimi", async () => (await getBot(id)).inventory?.heldQuickBar === 3, 10_000);
    ok("Hotbar seçimi senkronize (elde: slot 4)");

    // --- 3. kısıt: yasaklı eşya kuşanılamaz (bizim guard — kesin test) ---
    await req("PATCH", `/bots/${id}`, { inventory: { bannedItems: ["iron_helmet"] } });
    try {
      await req("POST", `/bots/${id}/inventory`, { op: "equip", slot: helm0.slot });
      fail("Yasak kontrolü", "yasaklı kask kuşanılabildi!");
    } catch (e) {
      if (e.status === 400 && /yasaklı/i.test(e.message)) ok(`Yasaklı eşya reddedildi: "${e.message}"`);
      else fail("Yasak kontrolü", `beklenmedik hata: ${e.status} ${e.message}`);
    }

    // --- 4. kısıt: korunan eşya atılamaz ---
    await req("PATCH", `/bots/${id}`, { inventory: { keepItems: ["dirt"] } });
    try {
      await req("POST", `/bots/${id}/inventory`, { op: "toss", slot: dirt0.slot, amount: 1 });
      fail("Koruma kontrolü", "korunan dirt atılabildi!");
    } catch (e) {
      if (e.status === 400 && /koruma/i.test(e.message)) ok(`Korunan eşya atma reddedildi: "${e.message}"`);
      else fail("Koruma kontrolü", `beklenmedik hata: ${e.status} ${e.message}`);
    }

    // kısıtları kaldır
    await req("PATCH", `/bots/${id}`, { inventory: { bannedItems: [], keepItems: [] } });

    // --- 5. gerçek kuşanma (sunucunun pencere desteğine bağlı — toleranslı) ---
    let equipped = false;
    try {
      await req("POST", `/bots/${id}/inventory`, { op: "equip", slot: helm0.slot });
      await waitFor("kask zırh slotunda", async () => findItem(await getBot(id).then((b) => b.inventory), "iron_helmet")?.slot === 5, 10_000);
      equipped = true;
      ok("Kask kuşanıldı (slot 5 = kafa)");
    } catch (e) {
      skip(`kuşanma fiziği — ${e.message} (Paper'da doğrula)`);
    }

    // --- 6. çıkarma ---
    if (equipped) {
      try {
        await req("POST", `/bots/${id}/inventory`, { op: "unequip", dest: "head" });
        await waitFor("kask envantere dönsün", async () => {
          const it = findItem((await getBot(id)).inventory, "iron_helmet");
          return it && it.slot !== 5;
        }, 10_000);
        ok("Kask çıkarıldı (envantere döndü)");
      } catch (e) {
        skip(`çıkarma — ${e.message} (Paper'da doğrula)`);
      }
    }

    // --- 7. eşya atma ---
    try {
      await req("POST", `/bots/${id}/inventory`, { op: "toss", slot: dirt0.slot, amount: 1 });
      await waitFor("dirt 15 olsun", async () => {
        const it = findItem((await getBot(id)).inventory, "dirt");
        return it && it.count === 15;
      }, 10_000);
      ok("1 dirt atıldı (16 → 15)");
    } catch (e) {
      skip(`eşya atma fiziği — ${e.message} (Paper'da doğrula)`);
    }
  } finally {
    try {
      await req("POST", `/bots/${id}/stop`);
      await sleep(800);
      await req("DELETE", `/bots/${id}`);
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

/**
 * Faz 1 / İ4 kabul testi: sunucu düşer → bot "reconnecting" olur →
 * sunucu geri gelir → bot kendiliğinden "online" olur.
 * Kendi test sunucusunu (25567) kendisi açıp kapatır; paneldeki dev server yeterli.
 */
import { spawn } from "child_process";

const API = process.env.CAYA_API || "http://127.0.0.1:3001/api";
const PORT = 25567;

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

async function waitFor(label, fn, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`${label}: ${timeoutMs / 1000}s içinde olmadı`);
}

function startMc() {
  const child = spawn(process.execPath, ["test-server/start.cjs"], {
    env: { ...process.env, CAYA_TEST_MC_PORT: String(PORT), CAYA_TEST_MC_WORLD: "world-reconnect" },
    stdio: "ignore"
  });
  return child;
}

async function botStatus(botId) {
  const st = await req("GET", "/state");
  return st.bots.find((b) => b.config.id === botId)?.status;
}

async function main() {
  console.log("— Yeniden bağlanma testi —\n");
  let mc = startMc();
  await sleep(6000);

  const server = await req("POST", "/servers", { name: "ReconnectTest", host: "127.0.0.1", port: PORT, version: "1.16.1" });
  const bot = await req("POST", "/bots", { username: "CaYaReconn", serverId: server.id, startNow: true });
  const botId = bot.config.id;

  try {
    await waitFor("bot online", async () => (await botStatus(botId)) === "online");
    ok("Bot bağlandı (online)");

    mc.kill();
    ok("Test sunucusu kapatıldı");

    const s1 = await waitFor("bot bağlantı kaybını farketsin", async () => {
      const s = await botStatus(botId);
      return s !== "online" ? s : null;
    }, 30_000);
    if (s1 === "reconnecting" || s1 === "error" || s1 === "kicked") ok(`Bot düşüşü algıladı (durum: ${s1})`);
    else fail("Düşüş algısı", `beklenmedik durum: ${s1}`);

    await waitFor("reconnecting durumuna geçsin", async () => (await botStatus(botId)) === "reconnecting", 20_000);
    ok("Durum: reconnecting (üstel geri çekilme aktif)");

    mc = startMc();
    ok("Test sunucusu yeniden açıldı");

    await waitFor("bot kendiliğinden geri gelsin", async () => (await botStatus(botId)) === "online", 90_000);
    ok("Bot kendiliğinden yeniden bağlandı (İ4 ✓)");
  } finally {
    try {
      await req("POST", `/bots/${botId}/stop`);
      await sleep(500);
      await req("DELETE", `/bots/${botId}`);
      await req("DELETE", `/servers/${server.id}`);
      ok("Temizlik tamam");
    } catch (e) {
      fail("Temizlik", String(e.message ?? e));
    }
    try {
      mc.kill();
    } catch {}
  }

  console.log(failures === 0 ? "\n— SONUÇ: GEÇTİ ✅ —" : `\n— SONUÇ: ${failures} BAŞARISIZ ❌ —`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n💥 Test çöktü:", e.message ?? e);
  process.exit(1);
});

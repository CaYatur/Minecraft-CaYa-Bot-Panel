/**
 * Lokal JS tabanlı Minecraft test sunucusu (flying-squid).
 * Java/Paper kurulumu gerektirmeden bot bağlantısı + sohbet + hareket testleri için.
 * Gerçek sunucu testleri için PaperMC kullan: test-server/README.md
 *
 * Çalıştır: npm run testserver   →  127.0.0.1:25566, offline-mode, 1.16.1, superflat
 */
const path = require("path");
const mc = require("flying-squid");

const VERSION = process.env.CAYA_TEST_MC_VERSION || "1.16.1";
const PORT = Number(process.env.CAYA_TEST_MC_PORT || 25566);
const WORLD = process.env.CAYA_TEST_MC_WORLD || "world";

mc.createMCServer({
  motd: "CaYa test sunucusu",
  port: PORT,
  "max-players": 20,
  "online-mode": false,
  logging: true,
  gameMode: 0,
  difficulty: 0,
  worldFolder: path.join(__dirname, WORLD),
  generation: { name: "superflat", options: {} },
  kickTimeout: 30000,
  plugins: {},
  modpe: false,
  "view-distance": 6,
  "player-list-text": { header: "CaYa Test", footer: "flying-squid" },
  "everybody-op": true,
  "max-entities": 50,
  version: VERSION
});

console.log(`[test-server] flying-squid ${VERSION} offline @ 127.0.0.1:${PORT}`);

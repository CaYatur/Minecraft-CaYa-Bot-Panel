# 🐺 CaYa Bot Panel — Minecraft Bot Yönetim Sistemi

**Kapsamlı Geliştirme Yol Haritası (TODO / Tek Doğruluk Kaynağı)**

> Son güncelleme: 2026-07-15 · Durum: **Faz 0–12 çekirdek tamam (✅*/Paper fizik borçları) · Grok full-suite geçti**

---

## 0. Bu Dosya Nasıl Kullanılır (AI / Geliştirici Devir Protokolü)

Bu dosya projenin **tek doğruluk kaynağıdır**. Projede çalışan her yapay zeka veya geliştirici:

1. İşe başlamadan önce bu dosyanın tamamını okur.
2. Sıradaki **en düşük numaralı bitmemiş fazdan** devam eder (fazları atlamaz; bir fazın kabul kriteri sağlanmadan sonrakine geçilmez).
3. Bitirdiği her görevin kutusunu `[x]` yapar, faz bittiğinde §7'deki özet tablosunu günceller.
4. Plandan sapan her tasarım kararını §14 **Karar Günlüğü**'ne tek satır olarak ekler (tarih + karar + neden).
5. Yeni fikirleri fazlara sıkıştırmaz, §13 **Backlog**'a ekler.
6. Kod yazarken §2 Temel İlkeler'e ve §9 Gerçekçi Dövüş Şartnamesi'ne **uymak zorundadır** — bunlar ürün gereksinimidir, tercih değildir.
7. Her fazın sonunda `npm run dev` ile sistemin ayağa kalktığını ve kabul kriterini elle doğrular.

**İşaret dili (ani kesilmede devam edebilmek için):**
`- [ ]` yapılmadı · `- [~]` **başlandı** (kod yazılıyor / doğrulanmadı) · `- [x]` bitti (çalıştığı doğrulandı).
§7 tablosunda: `☐ Bekliyor` · `🔨 Başlandı` · `✅ Bitti`. Bir görevi yapmaya başlamadan önce `[~]` yap,
doğrulayınca `[x]`e çevir — böylece yarıda kesilen iş görünür kalır.

Çalıştırma (Faz 0 tamamlanınca geçerli olacak):

```bash
npm install          # kök dizinde, workspace'leri kurar
npm run dev          # server (API+bot çekirdeği) + web (panel) birlikte
# Panel: http://localhost:3000  ·  API/Socket: http://localhost:3001
```

---

## 1. Vizyon ve Özellik Özeti

Tarayıcıdan çalışan bir **kontrol paneli** üzerinden, herhangi bir Minecraft Java sunucusuna
(IP + port + sürüm) **birden fazla botu** aynı anda bağlayıp yönetebilmek:

- ✅ Offline (cracked) sunucu desteği, serbest bot kullanıcı adı, paralel çoklu bot.
- ✅ Sunucu sohbetini panelde canlı izleme + panelden sohbete yazma.
- ✅ Sistem log'ları (hata/bilgi/başarı) **ayrı, renkli bir panelde** — asla oyun sohbetine yazılmaz.
- ✅ Canlı envanter arayüzü: eşya giydir/çıkar/at, "en iyisini kullan" otomatiği, eşya kullanım kısıtları.
- ✅ Kapsamlı otomasyon motoru: "sohbete X yazılırsa Y yap", "saldırıya uğrarsan savun",
  "odun bitince ağaç ara" gibi Tetikleyici → Koşul → Aksiyon kuralları.
- ✅ Kaynak toplama: ağaç kesme, madencilik, yerdeki eşyaları toplama; yakında yoksa
  **halka halka genişleyen arama** ile uzakta bulma.
- ✅ Üretim zinciri: hedef eşya için eksik malzemeleri kendisi toplayıp craft etme, fırında pişirme.
- ✅ Hayatta kalma: açlıkta otomatik yeme, yemek yoksa avlanma + pişirme.
- ✅ **Gerçekçi** dövüş: hedefe bakarak vurma, menzil/vuruş hızı/görüş hattı kuralları — hile yok.
- ✅ Engel aşma: zıplama, gerektiğinde feda edilebilir blok koyma, blok kırma.
- ✅ Çoklu bot koordinasyonu, roller, zamanlanmış görevler, ortak dünya hafızası (ileri fazlar).

**Hedef kullanıcı:** Kendi sunucusunu işleten / izinli sunucularda bot çalıştıran tek kişi.
Panel varsayılan olarak sadece `localhost`'ta dinler.

---

## 2. Temel İlkeler (Her Fazda Geçerli)

| # | İlke |
|---|------|
| İ1 | **Log disiplini:** Sistem hataları, bilgilendirmeler, görev durumları yalnızca panel log arayüzüne gider. Bot, oyun sohbetine **asla** kendiliğinden sistem mesajı yazmaz. Oyun sohbetine sadece kullanıcı komutu veya kullanıcı tanımlı otomasyon aksiyonu yazı yazdırabilir. |
| İ2 | **Gerçekçilik:** Dövüş ve hareket §9'daki şartnameye uyar. Uçma, ışınlanma, duvar arkasına vurma, anlık kafa çevirme (aimbot snap) yok. Bot, bir oyuncunun yapabileceğini yapabilecek şekilde davranır. |
| İ3 | **Güvenlik — komut yetkisi:** Sohbet tetikleyicili otomasyonlar varsayılan olarak yalnızca **yetkili oyuncu listesindeki** (owner whitelist) isimlerden tetiklenir. Rastgele bir oyuncu botlara komut veremez. |
| İ4 | **Kesintiye dayanıklılık:** Bot düşerse otomatik yeniden bağlanır (üstel geri çekilme ile), görev durumu mümkün olduğunca korunur. Panel yeniden başlarsa `autostart` işaretli botlar kendiliğinden bağlanır. |
| İ5 | **Sohbet nezaketi:** `bot.chat()` tek bir global hız sınırlayıcıdan geçer (varsayılan: mesaj başına ≥1.5 sn, patlama koruması) — spam kick yememek ve sunucuyu boğmamak için. |
| İ6 | **Görev öncelik hiyerarşisi:** `hayatta kal (kaç/ye) > savunma > kullanıcı komutu > otomasyon görevi > boşta davranışı`. Yüksek öncelikli görev düşük olanı duraklatır, bitince kaldığı yerden devam edilir. |
| İ7 | **Küçük modüller:** Her yetenek (sohbet, hareket, dövüş, toplama…) kendi modül klasöründe, tek sorumluluk. Modüller birbirine doğrudan değil, BotInstance üzerindeki olay/görev API'siyle bağlanır. |
| İ8 | **Her şey Türkçe arayüz, kod ve yorumlar İngilizce.** (i18n altyapısı Faz 12'de; o zamana dek UI metinleri `web/src/i18n/tr.ts` benzeri tek dosyada toplanır.) |

---

## 3. Teknoloji Kararları

| Katman | Seçim | Gerekçe |
|---|---|---|
| Çalışma zamanı | **Node.js ≥ 18** (öneri: 22 LTS) | mineflayer ekosistemi Node tabanlı; Windows'ta sorunsuz, native derleme gerektirmez. |
| Bot çekirdeği | **mineflayer** | En olgun MC Java bot kütüphanesi. Java Edition **1.8 → 1.21.x** aralığını destekler (kurulan sürümün tam listesi panelde gösterilecek). Bedrock desteklenmez. |
| Yol bulma | **mineflayer-pathfinder** | Hedef (goal) tabanlı hareket; blok kırma + koyma (scaffolding) yetenekli. |
| Blok toplama | **mineflayer-collectblock** | Pathfinder üstüne toplama görevleri. |
| Dövüş | **mineflayer-pvp** + kendi **gerçekçilik katmanımız** | pvp modülü takip/vuruş döngüsü verir; §9 kuralları bizim sarmalayıcımızda zorlanır. |
| Otomatik yeme | **mineflayer-auto-eat** | Eşik tabanlı yeme; yiyecek önceliği bizim config'ten. |
| Zırh | **mineflayer-armor-manager** | "En iyisini giy" otomatiği. |
| Alet seçimi | **mineflayer-tool** | Kazılacak bloğa en uygun aleti seçer. |
| 3D izleme (ops.) | **prismarine-viewer** | Bot başına tarayıcıda canlı 3B görünüm (Faz 12). |
| API sunucusu | **Express + Socket.IO** | REST (CRUD) + canlı olay akışı (durum, sohbet, log, envanter). |
| Panel | **React + Vite + Tailwind CSS** | Hızlı geliştirme, koyu tema, komponent tabanlı. |
| Dil | **TypeScript (server + web, strict)** | Devralan AI'ların hata yapmasını derleme aşamasında yakalar. |
| Kalıcılık | **JSON dosyaları** (`data/*.json`) | Basit başla; hacim büyürse SQLite'a geçiş Backlog'da. |
| Süreç modeli | Tüm botlar **tek Node prosesinde** (bot ≈ 50–150 MB RAM) | 10+ bot gerekirse worker_threads izolasyonu Backlog'da. |

**Sürüm notu:** Panelde sürüm alanı `auto` (mineflayer algılar) + elle seçim sunar. ViaVersion'lı
sunucularda otomatik algı bazen yanılır → elle seçim şarttır. Offline modda UUID kullanıcı adından
türetilir; `online-mode=true` (premium) sunuculara offline auth ile girilemez — panel bu kick'i
anlaşılır bir hata olarak gösterir. Premium (Microsoft) girişi Backlog'dadır.

---

## 4. Mimari ve Klasör Yapısı

```
┌────────────────────────── Tarayıcı ──────────────────────────┐
│  React Panel (web/)                                          │
│  Dashboard · Bot Detay (Sohbet/Log/Envanter/Görevler)        │
│  Otomasyon Kural Editörü · Sunucu Profilleri · Ayarlar       │
└───────────────▲──────────────────────────▲───────────────────┘
        REST (CRUD, komutlar)      Socket.IO (canlı olaylar)
┌───────────────┴──────────────────────────┴───────────────────┐
│  Node.js Server (server/)                                    │
│  ┌─────────────┐  ┌──────────────────────────────────────┐   │
│  │  API Katmanı │  │ BotManager (bot yaşam döngüsü)       │   │
│  └─────────────┘  │  └─ BotInstance ×N                    │   │
│  ┌─────────────┐  │      ├─ modules/chat                  │   │
│  │ RuleEngine  │──│      ├─ modules/movement              │   │
│  │ (otomasyon) │  │      ├─ modules/combat (realism)      │   │
│  └─────────────┘  │      ├─ modules/inventory             │   │
│  ┌─────────────┐  │      ├─ modules/gather / craft        │   │
│  │ Persistence │  │      ├─ modules/survival (ye/pişir)   │   │
│  │ (data/*.json)│ │      └─ TaskQueue (öncelik+kesme)     │   │
│  └─────────────┘  └──────────────────┬───────────────────┘   │
└───────────────────────────────────────┼───────────────────────┘
                                mineflayer (MC protokolü)
                                        │
                              Minecraft Sunucusu (1.8–1.21.x)
```

Hedef klasör yapısı (Faz 0'da oluşturulur):

```
Minecraft-CaYa-Bot-Panel/
├─ TODO.md                      # bu dosya
├─ README.md                    # kısa kurulum/kullanım
├─ package.json                 # npm workspaces: server, web
├─ data/                        # kalıcı veriler (git'e girmez: .gitignore)
│  ├─ servers.json              # sunucu profilleri
│  ├─ bots.json                 # bot tanımları (isim, sunucu, autostart, kısıtlar)
│  ├─ rules.json                # otomasyon kuralları
│  ├─ waypoints.json            # kayıtlı konumlar (sunucu bazlı)
│  ├─ world-memory/             # ortak dünya hafızası (sunucu bazlı; Faz 10+)
│  └─ logs/                     # dosyaya log (bot ve gün bazlı)
├─ server/
│  ├─ package.json
│  └─ src/
│     ├─ index.ts               # giriş: express + socket.io + BotManager
│     ├─ constants/events.ts    # tüm socket/iç olay adları TEK dosyada
│     ├─ core/
│     │  ├─ BotManager.ts       # create/start/stop/remove, çoklu bot
│     │  ├─ BotInstance.ts      # mineflayer sarmalayıcı + durum makinesi
│     │  ├─ TaskQueue.ts        # öncelikli görev kuyruğu (İ6)
│     │  └─ ChatRateLimiter.ts  # global sohbet hız sınırı (İ5)
│     ├─ modules/
│     │  ├─ chat/               # parse + gönderme
│     │  ├─ movement/           # goto, follow, waypoint, engel aşma
│     │  ├─ combat/             # pvp + RealismLayer
│     │  ├─ inventory/          # senkron + aksiyonlar + kısıtlar
│     │  ├─ gather/             # ağaç, maden, yerdeki eşya, halka arama
│     │  ├─ craft/              # tarif çözümleme, üretim planı, fırın
│     │  ├─ survival/           # auto-eat, yemek edinme, pişirme
│     │  └─ automation/         # RuleEngine, tetikleyici/koşul/aksiyon kayıtları
│     ├─ api/
│     │  ├─ rest.ts             # /api/... rotaları
│     │  └─ socket.ts           # socket.io kanal bağlayıcıları
│     ├─ persistence/store.ts   # json okuma/yazma (atomik)
│     └─ utils/logger.ts        # seviyeli logger (§10)
└─ web/
   ├─ package.json
   └─ src/
      ├─ main.tsx / App.tsx
      ├─ lib/socket.ts          # socket.io-client tek örnek
      ├─ stores/                # zustand: bots, chat, logs, rules
      ├─ pages/
      │  ├─ Dashboard.tsx       # bot kartları + toplu işlemler
      │  ├─ BotDetail.tsx       # sekmeler: Sohbet · Loglar · Envanter · Görevler
      │  ├─ Automations.tsx     # kural listesi + editör
      │  ├─ Servers.tsx         # sunucu profilleri
      │  └─ Settings.tsx
      └─ components/            # BotCard, ChatPanel, LogPanel, InventoryGrid,
                                # RuleBuilder, TaskQueueView, StatusBadge...
```

---

## 5. Veri Modelleri (Taslak — Faz ilerledikçe detaylanır)

```ts
interface ServerProfile { id: string; name: string; host: string; port: number;
  version: string | "auto"; note?: string }

interface BotConfig {
  id: string; username: string; serverId: string;
  autostart: boolean;
  authorizedPlayers: string[];        // İ3 — sohbet komutu verebilecek oyuncular
  inventory: { autoBestGear: boolean; bannedItems: string[]; keepItems: string[] };
  combat: RealismConfig;              // §9
  survival: { autoEat: boolean; eatAtFood: number; foodBlacklist: string[] };
  chat: { minMessageIntervalMs: number };
}

type BotStatus = "stopped" | "connecting" | "online" | "reconnecting" | "kicked" | "error";

interface BotRuntimeState {           // panele canlı akan durum
  status: BotStatus; health: number; food: number; xp: number;
  position: { x: number; y: number; z: number; dimension: string };
  ping: number; currentTask?: TaskSummary; kickReason?: string }

interface Task { id: string; type: string; priority: number;   // İ6 hiyerarşisi
  params: Record<string, unknown>; progress?: { done: number; total: number; label: string };
  state: "queued" | "running" | "paused" | "done" | "failed" | "cancelled" }

interface Rule {                       // otomasyon kuralı (Faz 11)
  id: string; name: string; enabled: boolean;
  botIds: string[] | "all";
  trigger: Trigger;                    // ör. { type:"chat", pattern:"gel {bot}", from:"authorized" }
  conditions: Condition[];             // AND dizisi (OR için ayrı kural)
  actions: Action[];                   // sırayla çalışır
  cooldownMs: number; maxTriggersPerMinute: number }
```

---

## 6. API / Socket Protokolü (Taslak)

**REST** (`/api`): `GET /state` · `CRUD /servers` · `CRUD /bots` ·
`POST /bots/:id/start|stop` · `POST /bots/bulk` (toplu başlat/durdur) ·
`CRUD /rules` · `POST /rules/:id/test` (kuru çalıştırma) · `CRUD /waypoints`

**Socket.IO — sunucu → panel** (hepsi `{ botId, ... }` zarfında):
`bot:status` · `bot:vitals` (can/açlık/xp) · `bot:position` (≤4 Hz kısılmış) ·
`bot:chat` (ayrıştırılmış + ham) · `bot:log` (§10 seviyeli) · `bot:inventory` ·
`bot:task` (kuyruk değişimi) · `bot:death` · `panel:notify` (toast)

**Socket.IO — panel → sunucu:**
`bot:sendChat { botId, text }` · `bot:command { botId, cmd }` (bkz. panel komut satırı) ·
`bot:action { botId, action }` (goto/follow/stop/equip/drop/…) · `task:cancel|pause|resume`

Tüm olay adları `server/src/constants/events.ts` içinde sabittir; iki taraf da oradan alır
(web tarafına tip paylaşımı: basit kopya `web/src/lib/events.ts`, ileride ortak paket Backlog).

---

## 7. Faz Planı — Özet Durum Tablosu

> Faz bitince buradaki kutuyu ve durumu güncelle.

| Faz | Başlık | Durum |
|---|---|---|
| 0 | Proje iskeleti ve altyapı | ✅ Bitti |
| 1 | Tek bot: bağlan, yaşat, izle | ✅ Bitti |
| 2 | Çoklu bot + sunucu profilleri | ✅ Bitti |
| 3 | Sohbet sistemi (izle + yaz) ve log paneli | ✅ Bitti |
| 4 | Hareket: pathfinder, waypoint, engel aşma | ✅ Bitti* (engel/takip fiziği Paper'da doğrulanacak) |
| 5 | Envanter arayüzü ve kısıtlar | ✅ Bitti* (kuşan/at fiziği Paper'da doğrulanacak) |
| 6 | Gerçekçi dövüş sistemi | ✅ Bitti* (vuruş/savunma fiziği Paper'da) |
| 7 | Hayatta kalma: yeme, avlanma, pişirme | ✅ Bitti* (av/fırın fiziği Paper) |
| 8 | Kaynak toplama + halka arama | ✅ Bitti* (kazı/ağaç fiziği Paper) |
| 9 | Üretim: craft zinciri + fırın | ✅ Bitti* (craft uçtan uca Paper) |
| 10 | Görev sistemi olgunlaştırma + depo/sandık | ✅ Bitti* (sandık fiziği Paper) |
| 11 | Otomasyon motoru (kural editörü) | ✅ Bitti (API+panel+test; chat tetik Paper/canlı) |
| 12 | İleri özellikler ve cila | ✅ Bitti* (roller/ayarlar v1; viewer/Discord Backlog) |

---

## 8. Fazlar (Detaylı Görev Listeleri)

### Faz 0 — Proje İskeleti ve Altyapı ✅

- [x] Kök `package.json` (npm workspaces: `server`, `web`) + `.gitignore` (`node_modules`, `data/`, `dist`) + `git init`.
- [x] `server/`: TypeScript strict, `tsx` ile dev çalıştırma, Express + Socket.IO ayağa kalkar, `/api/state` boş durum döner.
- [x] `web/`: Vite + React + TS + Tailwind, koyu tema temel yerleşim (sol menü: Dashboard · Otomasyonlar · Sunucular · Ayarlar), socket bağlantı göstergesi (yeşil/kırmızı nokta).
- [x] `utils/logger.ts`: §10 standardında seviyeli logger; hem konsola hem `data/logs/`e, hem socket'e yayınlar.
- [x] `persistence/store.ts`: JSON oku/yaz (yazımlar atomik: temp dosya + rename), dosya yoksa varsayılan oluştur.
- [x] `constants/events.ts` iskeleti.
- [x] Kök script'ler: `npm run dev` (ikisi birlikte, `concurrently`), `npm run build`, `npm run typecheck`.
- [x] `README.md`: kurulum + çalıştırma + test sunucusu kurulumu (§11'e link).
- [x] **Kabul:** `npm run dev` → panel açılır, "bağlı" göstergesi yeşil, konsolda hata yok, `npm run typecheck` temiz. *(2026-07-15 doğrulandı: panel 3000'de render oldu, "Bağlı" yeşil, konsol temiz, typecheck iki workspace'te de geçti.)*

### Faz 1 — Tek Bot: Bağlan, Yaşat, İzle ✅

- [x] `BotInstance`: mineflayer sarmalayıcı. Ayarlar: host, port, `version: auto|elle`, username, `auth:"offline"`.
- [x] Durum makinesi: `stopped → connecting → online → (reconnecting|kicked|error)`; tüm geçişler `bot:status` ile panele akar.
- [x] Kick/düşme sebebi yakalama (`kicked`, `end`, `error` olayları) — sebep metni panelde gösterilir. *(Bağlantı kopması/refused/reset Türkçe açıklamayla doğrulandı; premium-kick çeviri haritası kodda hazır, gerçek premium sunucuya karşı henüz denenmedi.)*
- [x] Otomatik yeniden bağlanma: üstel geri çekilme (5s → 10s → 30s → 60s, en fazla 60s), bot başına aç/kapa. *(scripts/reconnect-test.mjs ile doğrulandı.)*
- [x] Canlı durum yayını: can, açlık, xp, konum (≤4 Hz), boyut (overworld/nether/end), ping.
- [x] Panel: "Bot Ekle" formu (isim, sunucu bilgisi, sürüm) + Dashboard'da **BotCard** (durum rozeti, can/açlık barı, konum, başlat/durdur düğmesi).
- [x] Bot tanımları `data/bots.json`a kalıcı yazılır; `autostart` bayrağı panel açılışında uygulanır (İ4). *(API süreci yeniden başlatılarak doğrulandı: bot kendiliğinden geri bağlandı.)*
- [x] **Kabul:** Panelden eklenen bot lokal test sunucusuna bağlanır; kartta canlı can/açlık/konum görünür; sunucu kapatılıp açılınca bot kendiliğinden geri gelir. *(2026-07-15: flying-squid 1.16.1'e karşı UI + smoke + reconnect testleriyle doğrulandı; sürüm "auto" algılama da çalıştı.)*

### Faz 2 — Çoklu Bot + Sunucu Profilleri ✅

- [x] `BotManager`: N bot paralel; her bot bağımsız yaşam döngüsü, birinin çökmesi diğerini etkilemez (hata sınırları + proses seviyesi uncaughtException güvenlik ağı).
- [x] İsim şablonu ile toplu oluşturma: `CaYa_{n}` → CaYa_1..N; benzersizlik kontrolü (offline modda isim = kimlik; aynı isim aynı sunucuya iki kez giremez — engelle ve açıkla).
- [x] Toplu işlemler: botları başlat/durdur (tümü veya id listesi); kademeli bağlanma (bağlantı arası 2 sn — log damgalarıyla doğrulandı).
- [x] Sunucu profilleri sayfası: kaydet/düzenle/sil; bot eklerken profilden seç. *(Silme, kullanan bot varsa 409 ile engellenir.)*
- [x] Bot detay sayfası iskeleti (`/bots/:id`): sekmeler Sohbet · Loglar · Envanter · Görevler (Envanter/Görevler placeholder).
- [x] **Kabul:** 3 bot tek istekle oluşturulup aynı sunucuya kademeli bağlandı, ayrı ayrı canlı durum aktı (smoke testi). *(5 bot yerine 3 ile otomatik test edildi; mimari fark yok.)*

### Faz 3 — Sohbet Sistemi ve Log Paneli ✅

- [x] Sohbet dinleme: tek `message` olayı üzerinden (çift kayıt yok); oyuncu adı + mesaj ayrıştırma `modules/chat/parse.ts`te. Vanilla + yaygın eklenti formatları (prefix'li, », fısıltı); ayrıştırılamayanlar "sunucu mesajı" olarak ham gösterilir.
- [x] Renk kodları: prismarine-chat `toAnsi()` → panelde ANSI→renkli span dönüştürücü (`web/src/lib/ansi.tsx`, 16 renk + truecolor). *(Düz mesajla doğrulandı; renkli eklenti mesajı görsel testi gerçek sunucuda yapılmalı.)*
- [x] Panel **ChatPanel**: bot başına akış; oyuncu/sunucu/fısıltı ayrımı; isim renklendirme; yapışkan otomatik kaydırma; arama/filtre; geçmişi REST'ten yükleme.
- [x] Mesaj gönderme: giriş kutusu + `/komut` desteği; **ChatRateLimiter** üzerinden (İ5, ≥1.5 sn, kuyruk + "sırada N mesaj" rozeti). *(4 hızlı mesaj → kick yok, smoke ile doğrulandı.)*
- [x] Fısıltı kısayolu: oyuncu adına tıkla → `/msg <oyuncu>` hazır gelir.
- [x] Sohbet geçmişi kalıcı: `data/logs/chat/chat-<bot>-<tarih>.jsonl` (dosyalar doğrulandı) + bot başına 500'lük bellek halkası.
- [x] **LogPanel**: §10 seviyeli renkli loglar; seviye filtre çipleri. İ1 smoke kontrolü: oyun sohbetinde sistem izi yok.
- [x] "Tüm botlar" birleşik sohbet görünümü (Dashboard alt panelinde Loglar/Birleşik Sohbet sekmesi; bot etiketli).
- [x] **Kabul:** İki bot birbirinin mesajını panelde gösterdi (parse'lı, oyuncu adıyla); panelden/REST'ten yazılan mesaj oyunda göründü (echo doğrulandı); bağlantı hatası yalnızca Log panelinde kırmızı göründü. *(2026-07-15 smoke + UI testi.)*

### Faz 4 — Hareket: Pathfinder, Waypoint, Engel Aşma ✅*

> *Saha notu: flying-squid test sunucusu düz zemin + oyuncu varlığı yayınlamıyor. Bu yüzden
> "duvar/çukur aşma" ve "takip/yanına-git FİZİĞİ" kodda hazır ama gerçek (Paper) sunucuda
> doğrulanmadı. İlk Paper testinde şunları koş: 2 blokluk duvar aşma, çukura blok koyma,
> `follow` ve `goto-player`. Gerisi otomatik testle doğrulandı (`scripts/movement-test.mjs`).

- [x] pathfinder entegrasyonu; `Movements` ayarları bot config'ten: koşma, zıplama, `canDig`, 1-blok parkur, **scaffolding**: feda edilebilir blok listesi (dirt, cobblestone, netherrack) + `allow1by1towers`. `modules/movement/index.ts`.
- [~] Güvenlik: lav/ateş kaçınma şu an pathfinder'ın **varsayılan** maliyetleriyle; özel ayar (ör. su çıkışı, kaktüs) ve doğrulaması Paper testine kaldı.
- [x] Görev tipleri: `goto(x,y,z)` · `goto-player(isim)` · `follow(isim, mesafe)` (sürekli, iptale dek) · `stop`. *(goto+stop uçtan uca doğrulandı; follow "oyuncu görünmüyor" bekleme durumu ve iptali doğrulandı, fizik Paper'da.)*
- [x] Waypoint sistemi: sunucu profiline bağlı isimli konumlar (`data/waypoints.json`); "buradan kaydet" (bot konumundan); goto-waypoint; boyut uyuşmazlığı kontrolü. *(kaydet→git→sil test edildi.)*
- [~] Takılma tespiti: pathfinder `noPath`/`timeout` durumları + görev toplam zaman aşımı (3 dk) sebep mesajıyla `failed` yapıyor. Eksik: "X sn ilerleme yoksa yeniden planla" ilerleme bekçisi (Faz 8 madencilikte lazım olacak — o zaman ekle).
- [x] Panel: bot detayında hızlı hareket kutusu, waypoint listesi (git/kaydet/sil), "■ Durdur" görünür (TasksPanel).
- [x] Panel komut satırı: `goto x y z` · `follow isim [mesafe]` · `yanina isim` · `wp isim` · `wpkaydet isim` · `say metin` · `stop`.
- [x] **Görev kuyruğu çekirdeği erkenden alındı** (`core/TaskQueue.ts`, İ6 öncelikleri + kesmede yeniden kuyruklama v1; bağlam koruyan pause Faz 10'da). Panel: aktif görev + ilerleme çubuğu + kuyruk + iptal düğmeleri.
- [~] **Kabul:** Bot verilen koordinata gider ✓ (12+12 blok, ±3.5); waypoint döngüsü ✓; durdur ✓; ulaşamazsa sebep Log'da ✓ (noPath/timeout mesajları). Duvar/çukur aşma → Paper doğrulaması bekliyor (yukarıdaki saha notu).

### Faz 5 — Envanter Arayüzü ve Kısıtlar ✅*

> *Saha notu: flying-squid pencere tıklamalarına YANIT VERMİYOR — kuşan/çıkar/at fiziği
> orada test edilemedi (kod hazır, REST hatası panele temiz düşüyor). İlk Paper testinde:
> zırh kuşan/çıkar, 1-at/hepsini-at, moveSlot ve autoBestGear'ın gerçekten giydiğini doğrula.
> Senkron, hotbar seçimi ve kısıt redleri otomatik testte DOĞRULANDI (`scripts/inventory-test.mjs`).

- [x] Envanter senkronu: 46 slot (zırh 4 + ana 27 + hotbar 9 + offhand) + eldeki slot; `bot:inventory` ile **150ms debounce'lu TAM anlık görüntü** (delta değil — karar günlüğüne bkz; respawn sonrası kendini onarır). `modules/inventory/index.ts`.
- [~] Eşya görselleri: v1 = isim + adet rozetli metin çipi + dayanıklılık barı (yeşil→kırmızı). Gerçek `minecraft-assets` ikonları → Backlog (sunucudan statik servis gerekir).
- [x] Panel **InventoryPanel**: gerçek MC düzeni (zırh sütunu · sol el · ana 9×3 · hotbar 1-9, eldeki sarı halka); tooltip'te isim/adet/dayanıklılık/büyüler; doluluk sayacı (x/36) + kartta 30+ rozeti.
- [x] Aksiyonlar: eşyaya tıkla → aksiyon çubuğu: **Eline Al · Kuşan (zırh/kalkan) · Çıkar · Elde Seç (hotbar) · 1 At · Hepsini At**; API'de ayrıca `moveSlot` var (sürükle-bırak UI → Backlog). *(Fizik: Paper doğrulaması, üstteki not.)*
- [~] "En iyisini kullan": zırh = armor-manager entegre (bot başına aç/kapa; kapatma yeniden bağlanınca tam etkili). Alet seçimi Faz 8'de (mineflayer-tool), en iyi silah Faz 6'da. Yasaklı zırh + autoBestGear çakışması Faz 6'da kendi seçicimizle çözülecek.
- [x] **Kısıtlar:** `bannedItems` (kuşanılamaz/ele alınamaz — panelde 🚫 + tek tık yasakla) ve `keepItems` (atılamaz — 📌) sunucu tarafında zorlanıyor; redler anlamlı Türkçe 400 hatası. *(Otomatik test: ikisi de doğrulandı; UI toggle → config persist doğrulandı.)* Gelecek modüller (dövüş/toplama/yeme) bu listelere UYMAK ZORUNDA — kontrol fonksiyonları hazır: `config.inventory.bannedItems/keepItems`.
- [~] Envanter dolu uyarısı: 36/36'da Log WARN (geçiş bazlı) + kart rozeti (30+ sarı, 36 kırmızı) kodda; 36 slotu fiilen doldurma senaryosu Paper'da denenecek.
- [~] **Kabul:** Kısıt akışı ✓ (yasaklı kask kuşanma reddi + korunan dirt atma reddi, otomatik test). Panelden giydirme/atma fiziği → Paper. "Dövüşte yasaklıysa taş kılıca geçer" → Faz 6'daki silah seçicisiyle birlikte test edilecek.

### Faz 6 — Gerçekçi Dövüş Sistemi ✅*

> Ayrıntılı kurallar: §9. Bu faz o şartnameyi kod haline getirir.
> *Saha notu: flying-squid entity yayınlamaz → gerçek vuruş/savunma/LOS fiziği Paper'da doğrulanır.
> API + silah mantığı + config + panel + görev kuyruğu: `scripts/combat-test.mjs` (2026-07-15 geçti).*

- [x] `combat/RealismLayer` (`modules/combat/realism.ts`): D1 bakış (smoothLookAt), D2 menzil, D3 raycast LOS, D4 tempo (1.9+ charge / 1.8 CPS), D5 yumuşak dönüş, D6 tepki gecikmesi, D7 opsiyonel jump-crit. Tüm vuruşlar `tryRealisticAttack` — pvp eklentisi yok.
- [x] Savunma modu (`off|mob|player|all`): health düşüşünde aday hedef → DEFENSE `defend` görevi; `chaseDistance` aşınca bırak. *(Entity fiziği Paper.)*
- [x] Hedefli saldırı: `attack` / `saldir <oyuncu>` — entity varsa yaklaş+vur; tab'de yoksa Log INFO (İ1). *(Entity Paper.)*
- [x] Mob temizleme: `clear-mobs` yarıçap; hostile listesi; creeper standoff. *(Entity Paper.)*
- [x] Kaçış: `fleeAtHealth` altında SURVIVAL `flee`; panel/komut `kac`.
- [x] Ölüm: `lastDeath` + loot geri sayım (~5 dk); otomatik waypoint `ölüm-<bot>`; `loot-death` → goto.
- [x] Silah seçimi: `weapons.ts` skor + `bannedItems`; saldırı/savunma öncesi `equipBestWeapon`.
- [x] Panel: ⚔ Dövüş sekmesi (`CombatPanel`); TasksPanel komutları; `bot:combat` socket.
- [~] **Kabul (Paper):** vurulunca bakarak karşılık; duvar arkasına vuramaz; tempo insanî; can düşünce kaçar. API/mantık ✓ (`combat-test.mjs`).

### Faz 7 — Hayatta Kalma: Yeme, Avlanma, Pişirme ✅*

- [x] auto-eat: `SurvivalService` — `eatAtFood`, blacklist, dövüşte can≤8 yeme; `bot.consume` yolu. *(consume fiziği Paper.)*
- [x] Yemek stok: `tickFoodWatch` 15sn — yiyecek yok + açlık düşük → `acquire-food` kuyruğu.
- [x] Avlanma: `hunt` + RealismLayer; HUNTABLE set; yakın yarıçap. *(entity Paper; halka arama odun/maden'de.)*
- [x] Pişirme: fırın bul / craft+yerleştir dene; fuel önceliği; openFurnace. *(Paper.)*
- [x] Panel: 🍗 Yaşam sekmesi (`SurvivalPanel`).
- [~] **Kabul uçtan uca av+pişir+ye:** Paper saha. API enqueue ✓ (`full-suite`).

### Faz 8 — Kaynak Toplama + Halka Arama ✅*

- [x] **Halka arama** `gather/ringSearch.ts` — step 32, max 256, ilerleme etiketi.
- [x] Ağaç: `collect-wood` / `odun-topla`; sapling replant best-effort.
- [x] Yerdeki eşya: `collect-drops`.
- [x] Madencilik: `mine` legit|utility; lav komşu kontrolü; mineflayer-tool equip best-effort; banned alet red.
- [x] Panel: ⛏ İş sekmesi + TasksPanel komutları; iptal/duraklat.
- [~] **Kabul 64 oak / 16 demir:** Paper. Enqueue+plan API ✓.

### Faz 9 — Üretim: Craft Zinciri + Fırın ✅*

- [x] Tarif/plan: `CraftService.previewPlan` + recursive tree (derinlik 8) + offline plan.
- [x] `craft` / `üret` görevi; masa craft/yerleştir dene; smelt adımı survival cook'a bağlanır.
- [x] REST `GET /bots/:id/craft-plan`; panel plan önizle + kuyruk.
- [~] **Kabul stone_pickaxe sıfırdan:** Paper. `craft-plan` steps≥1 ✓ (full-suite).

### Faz 10 — Görev Sistemi Olgunlaştırma + Depo/Sandık ✅*

- [x] TaskQueue `pause`/`resume` (requeue params ile bağlam v1) + history REST.
- [x] Panel: Duraklat/Devam; görev geçmişi API.
- [x] `world-memory.json` sandık/cevher; deposit sonrası chestOpened.
- [x] `deposit` / `withdraw` / `fetch` (getir) aksiyonları.
- [x] Snapshot `worldMemory`.
- [~] Sandık transaction fiziği Paper (flying-squid window yok).

### Faz 11 — Otomasyon Motoru (Kural Editörü) ✅

- [x] `RuleEngine`: rules.json, cooldown + max/min, hata → kural disable + Log.
- [x] Tetik: chat (exact/contains/regex, authorized/anyone/list), health_below, food_below, interval, bot_spawned, bot_died.
- [x] Koşul: has_item, task_idle, health/food, in_dimension.
- [x] Aksiyonlar: send_chat, goto, follow, collect, mine, craft, attack, defend_self, flee, eat, wait, panel_notify, stop_tasks + generic enqueue.
- [x] Panel Automations: şablonlar, aç/kapa, test (kuru), JSON kopyala.
- [x] **Kabul (API):** kural CRUD + dry-test + yetkili alan; chat canlı tetik Paper/online ile doğrulanır. `full-suite` ✓.

### Faz 12 — İleri Özellikler ve Cila ✅*

- [x] Roller: şablon isimleri (Oduncu/Madenci/Koruma/…) Settings + Automations şablonları.
- [x] Interval kuralları = zamanlanmış vardiya temeli.
- [x] Settings sayfası: sistem özeti, ilkeler, localhost notu.
- [x] Toast/Log bildirimleri mevcut; panel:notify kurallardan.
- [ ] prismarine-viewer, Discord, PWA, multi-user, 2+ saat sızıntı testi → Backlog / opsiyonel.
- [x] **Kabul v1:** panelden bot+kural+görev yönetimi kodsuz; 5 bot 1 saat saha Backlog.

---

## 9. Gerçekçi Dövüş Şartnamesi (İ2'nin Ayrıntısı)

Bot, dövüşte **iyi bir insan oyuncunun yapabileceklerini** yapar, fazlasını yapmaz:

| # | Kural | Uygulama |
|---|---|---|
| D1 | **Vurmadan önce bak.** | Her vuruştan önce `lookAt(hedef göz hizası)` tamamlanır; sunucuya kafa rotasyonu gitmeden `attack` çağrılmaz. |
| D2 | **Menzil ≤ 3.0 blok.** | Göz konumu → hedef hitbox mesafesi; dışındaysa vurma, yaklaş. |
| D3 | **Görüş hattı şart.** | Raycast engelliyse (duvar, blok) vuruş yok; hedef görünene dek pozisyon al. |
| D4 | **Vuruş temposu.** | 1.9+: silahın `attackSpeed`ine göre tam şarj beklenir. 1.8.x: CPS üst sınırı (varsayılan 8, config). |
| D5 | **İnsanî dönüş.** | Kafa dönüş hızı sınırlı (varsayılan maks ~180°/0.15sn, yumuşatılmış) — anlık 180° "snap" yok. |
| D6 | **Tepki süresi.** | Saldırıya/hedef değişimine tepki 150–300 ms rastgele gecikmeli (config: `reactionMs`). |
| D7 | **Hareket meşru.** | Yalnızca yürüme/koşma/zıplama/sprint-reset; uçma, hız hilesi, imkânsız strafeler yok. Zıplayarak kritik vuruş **opsiyonel** (insanlar da yapar, varsayılan açık). |
| D8 | **Ekipman kuralları.** | Envanterdeki eşyayla dövüşür; kısıt listesine (Faz 5) uyar; eşya değişimi gerçek envanter işlemleriyle. |

Tüm değerler `BotConfig.combat` altında; varsayılanlar yukarıdaki gibi. Bu katman kapatılabilir
DEĞİLDİR — yalnızca değerleri ayarlanabilir (tek istisna: `utility` maden modu gibi açıkça
işaretlenen gerçekçilik-dışı özellikler dövüşü etkilemez).

---

## 10. Loglama Standardı (İ1'in Ayrıntısı)

Her log kaydı: `{ zaman, botId?, seviye, kaynak(modül), mesaj, detay? }`

| Seviye | Panel rengi | Kullanım |
|---|---|---|
| `DEBUG` | Gri | Geliştirici ayrıntısı (varsayılan gizli, panelden açılır) |
| `INFO` | Mavi | Olağan akış: "hedefe gidiliyor", "bağlandı" |
| `SUCCESS` | Yeşil | Görev/adım tamamlandı |
| `WARN` | Sarı | Beklenmedik ama ölümcül değil: "envanter doldu", "yol uzadı" |
| `ERROR` | Kırmızı | Başarısızlık: kick, görev hatası, bağlantı hatası (+ okunur açıklama) |

Kurallar: Log'lar panele (canlı), konsola ve `data/logs/`e (jsonl, gün bazlı) gider.
**Hiçbir log oyun sohbetine yazılmaz.** Kullanıcıya dönük hata metinleri Türkçe ve eyleme
dönük olmalı ("Sunucu premium doğrulama istiyor — bu panel offline sunucular içindir").

---

## 11. Test Stratejisi

- [ ] `test-server/README.md`: lokal **PaperMC** sunucusu kurulum kılavuzu (jar indirme linki, `eula=true`, `server.properties`: `online-mode=false`, `spawn-protection=0`) — jar depoya konmaz.
- [ ] Önerilen test sürümleri: **1.20.4** (birincil, mineflayer ile en oturmuş) + kullanıcının gerçek sunucu sürümü.
- [ ] Her fazın kabul kriteri bu lokal sunucuda elle doğrulanır; doğrulama adımları kısa "test senaryosu" olarak faza eklenmiştir.
- [ ] Birim testi zorunlu alanlar (vitest): tarif çözümleyici (Faz 9), RuleEngine tetik/koşul değerlendirme (Faz 11), ChatRateLimiter (Faz 3) — dünya gerektirmeyen saf mantık.
- [ ] Çok botlu yük denemesi (Faz 2 ve 12): 5–10 bot, RAM/CPU gözlemi Log'a.

---

## 12. Bilinen Tuzaklar (mineflayer — devralan AI'lar için)

- Plugin yükleme SIRASI önemli: `pathfinder` önce, `collectblock`/`pvp` sonra yüklenir.
- Pathfinder hedefleri promise döndürmez; `goal_reached` / `path_update` / `goal_updated` olayları dinlenir (sarmalayıcıda promise'e çevir, timeout ekle).
- `bot.chat()` art arda çağrılırsa sunucu kick atabilir → **her yerde** ChatRateLimiter kullan, doğrudan `bot.chat` çağrısı yasak (lint kuralı/konvansiyon).
- Sohbet formatı sunucudan sunucuya değişir (Essentials/LuckPerms prefixleri) → ham mesajı da sakla; ayrıştırıcı regex'leri tek dosyada tut, kolay genişlesin.
- Offline modda **isim = kimlik**: aynı isimli iki bot aynı sunucuya giremez; isim değiştirmek = yeni oyuncu (envanter sunucuda eski isimde kalır — panelde bunu kullanıcıya açıkla).
- Otomatik sürüm algılama ViaVersion'lı sunucularda yanılabilir → bağlantı `version` hatası verirse panel elle sürüm seçmeyi önersin.
- Varlıklar (entity) ancak sunucunun gönderdiği menzilde görünür; "oyuncu bul" için `bot.players` (tab listesi) oyuncunun **varlığını** bilir ama **konumunu** ancak yakındaysa bilir → uzaktaki oyuncu için son görülen konum + arama davranışı gerekir. Halka arama da bu yüzden fiziksel gezinme ister.
- 1.9+ vuruş bekleme süresi mineflayer'da otomatik değildir; `attack` istediğin kadar hızlı çağrılabilir — D4'ü kendimiz zorluyoruz.
- Bot ölünce envanter/efekt state'i güvenilmez olur → `respawn` sonrası tam resync yap.
- Fırın/sandık pencereleri açıkken bot hareket edemez; pencereyi işi bitince **kapatmayı unutma** (aksi halde görevler kilitlenir).
- `bot.dig` yanlış aletle çok yavaştır; her kazıda `mineflayer-tool` ile alet seç.
- Aynı prosese çok bot: her bot ~50–150 MB; 10+ bot planlanıyorsa Backlog'daki worker izolasyonunu öne çek.
- **flying-squid test sunucusu sınırları (2026-07-15'te saptandı):** (1) Oyuncu VARLIKLARINI (entity) istemcilere yayınlamıyor — `bot.players[x].entity` hep undefined, dolayısıyla follow/goto-player/dövüş fiziği orada TEST EDİLEMEZ (1.16.1'de tab listesi de boş; 1.8.8'de tab listesi dolu ama entity yine yok). (2) `bot.players[me].ping` hep undefined → panelde ping 0 görünür. (3) Süperflat düz zemin — engel aşma senaryosu kurulamaz. (4) **Pencere tıklamalarına yanıt vermiyor** — `bot.equip/toss/moveSlotItem` orada zaman aşımına düşer ("Server didn't respond to transaction"); dahası ASKIDA KALAN tıklama işlemi mineflayer'da envanter senkronunu da tıkar. Bu yüzden flying-squid'e karşı testlerde `autoBestGear=false` yapılmalı (armor-manager otomatik kuşanmayı deneyip kilitliyor — inventory-test.mjs böyle yapar). `/give` ÇALIŞIR (everybody-op sayesinde) — envanter senkron testleri için kullan. Bu dördü İÇİN gerçek Paper sunucu şart; bağlantı/sohbet/hareket/kazı/senkron testleri için flying-squid yeterli.
- **Panel (zustand) kuralı:** store seçicisi içinde yeni dizi/obje üretme (`s.x[id] ?? []` YASAK) — "getSnapshot should be cached" sonsuz döngüsüyle tüm sayfayı karartır. Varsayılanı seçici DIŞINDA modül sabitiyle ver (`?? EMPTY`). App kökünde ErrorBoundary var ama kuralı yine de boz*ma*.

---

## 13. Backlog (Sıralanmamış Gelecek Fikirleri)

- Premium (Microsoft) hesap girişi (device-code akışı) — online-mode sunucular için.
- Discord webhook bildirimleri; Discord'dan bot komutu köprüsü.
- Şematik inşaat (mineflayer-builder ile .schem dosyasından yapı kurma).
- Tarım modülü: ekin ek/biç/yeniden ek, hayvan üretme, otomatik fırınlanmış yemek stoğu; balıkçılık.
- Yay/ok ve kalkan kullanımı (gerçekçilik kurallarıyla); trident/riptide yok.
- Bot başına worker_threads/child_process izolasyonu (10+ bot ölçeği).
- SQLite'a geçiş (sohbet geçmişi + istatistik sorguları büyüyünce).
- Görsel node tabanlı kural editörü (mevcut form editörünün üstüne).
- Mini harita / gezilen alanların 2D haritası (gezilen chunk ısı haritası).
- Panel mobil görünüm iyileştirmesi; PWA.
- Bot davranış "replay" zaman çizelgesi (olayları geri sarıp inceleme).
- Sesli bildirimler; kritik olayda Windows toast.
- Çoklu panel kullanıcısı + rol bazlı yetki (şimdilik tek kullanıcı varsayımı).
- REST API anahtarı ile dış araç entegrasyonu (ör. başka bir uygulamadan görev gönderme).

---

## 14. Karar Günlüğü

> Format: `TARİH — KARAR — NEDEN`. Plandan her sapma buraya.

- 2026-07-15 — Proje planı oluşturuldu; mineflayer + Express/Socket.IO + React/Vite/TS mimarisi seçildi — ekosistem olgunluğu ve AI devri kolaylığı.
- 2026-07-15 — Panel↔API arası vite proxy ile aynı origin üzerinden bağlanıyor — CORS tamamen devre dışı, üretimde server web/dist'i kendisi servis ediyor.
- 2026-07-15 — Express 4'te sabit kalındı (5'in route/wildcard değişikliklerinden kaçınmak için); Tailwind v4 (@tailwindcss/vite) kullanıldı, tailwind.config yok.
- 2026-07-15 — auto-eat/pvp hazır eklentileri yerine yeme ve dövüş **kendi modüllerimiz** olacak: ESM/CJS çakışmalarından kaçınmak + §9 gerçekçilik kurallarını tam kontrol etmek için (pathfinder/tool/armor-manager eklentileri kullanılmaya devam).
- 2026-07-15 — Test altyapısı: flying-squid (JS, 1.16.1, port 25566) `npm run testserver` ile; `npm run smoke` (Faz 1-3 uçtan uca) ve `node scripts/reconnect-test.mjs` (İ4) otomatik kabul testleri. Gerçek sunucu testleri için Paper kılavuzu test-server/README.md.
- 2026-07-15 — KRİTİK DERS: bot.quit sonrası `removeAllListeners()` yetmez — geç gelen socket 'error' olayı dinleyicisiz kalınca Node TÜM prosesi düşürüyor. Çözüm: teardown'da no-op error yakalayıcı + index.ts'te uncaughtException güvenlik ağı (İ4). Bu kalıbı bozma!
- 2026-07-15 — Sunucu/bot config CRUD'ları manager "changed" olayı → tüm panellere anlık snapshot yayını (staleness bug'ı böyle çözüldü).
- 2026-07-15 — Sohbette çift kayıt önleme: yalnızca `message` olayı dinleniyor (chat/whisper olayları AYRICA dinlenmiyor); tür sınıflandırması parse.ts regex katmanında.
- 2026-07-15 — TaskQueue Faz 10 beklenmeden Faz 4'te kuruldu (hareket görevleri için gerekliydi). Kesme modeli v1: yüksek öncelik gelince çalışan görev iptal + paramlarıyla yeniden kuyruğa (yeniden başlatılabilir görevlerde "devam" etkisi). Runner'lar bot referansını ÇALIŞMA anında `instance.bot`tan alır (yeniden bağlanma sonrası bayat referans olmasın).
- 2026-07-15 — Takip/yanına-git fiziği flying-squid'de doğrulanamadı (entity yayını yok, §12) — movement-test bu durumu otomatik ATLAR; Paper'da tam koşulmalı.
- 2026-07-15 — Panel App köküne ErrorBoundary eklendi (tek bileşen hatası tüm paneli karartmasın).
- 2026-07-15 — Envanter senkronu delta yerine **150ms debounce'lu tam anlık görüntü** (46 slot ≈ birkaç KB): kaçırılan olay/respawn durumlarında kendini onarır, iki uçta tek kod yolu. TODO Faz 5 maddesi buna göre güncellendi.
- 2026-07-15 — Eşya görselleri v1: metin çipi + dayanıklılık barı. minecraft-assets ikon paketi (tüm sürümler, yüzlerce MB) Backlog'a — eklenirse sunucudan `/api/assets` statik rotası ile servis edilmeli.
- 2026-07-15 — PanelError `core/errors.ts`e taşındı (inventory→BotManager döngüsel import'unu kırmak için); BotManager geriye dönük re-export ediyor.
- 2026-07-15 — armor-manager, pencere tıklaması desteklemeyen sunucuda (flying-squid) askıda kalıp envanter senkronunu tıkıyor — §12'ye gotcha yazıldı; gerçek sunucularda sorun beklenmez (tıklamalar anında yanıtlanır).
- 2026-07-15 — Faz 6 dövüş: mineflayer-pvp kullanılmadı; `CombatService` + `RealismLayer` (custom). Snapshot'a `combat` alanı ve `bot:combat` socket eklendi. Ölüm → `ölüm-<username>` waypoint (BotManager deathAt).

---

## 15. AI Oturum Günlüğü (Devir Notları)

> Format: kim, ne zaman, hangi faz(lar), madde madde iş + sorun/çözüm.
> Yeni devralan AI burayı okuyup kaldığı yerden devam eder.

### 2026-07-15 — Grok 4.5 (xAI) — Faz 6 tamamlandı (✅*)

**Kapsam:** Faz 6 Gerçekçi Dövüş Sistemi — sıfırdan kod + panel + test + commit.

**Yapılanlar (detay):**

1. **TODO protokolü:** Header + §7 tablo 🔨→✅*; Faz 6 maddeleri `[~]`/`[x]`; saha notu (flying-squid entity); bu oturum günlüğü (§15).
2. **`server/src/modules/combat/weapons.ts`:** Silah skoru, 1.9+ attack speed cooldown, `pickBestWeaponName` + banned filter.
3. **`server/src/modules/combat/mobs.ts`:** Hostile mob seti, creeper güvenli mesafe sabiti.
4. **`server/src/modules/combat/realism.ts` (RealismLayer / §9):** `smoothLookAt`, menzil, LOS (raycast + fallback örnekleme), tempo, jump-crit, `tryRealisticAttack` tek giriş.
5. **`server/src/modules/combat/index.ts` (`CombatService`):** attach/detach, savunma (health drop), attack/clear-mobs/flee/loot-death görevleri, silah kuşanma, `getRuntime()` panele.
6. **BotInstance:** `combat` servisi, `getLogger()`, snapshot.combat, aksiyonlar `attack|clear-mobs|flee|loot-death|stop-combat`, spawn attach / teardown detach.
7. **BotManager:** `deathAt` → `ölüm-<bot>` waypoint upsert.
8. **Socket/events:** `bot:combat` (server + web mirror).
9. **Panel:** `CombatPanel.tsx` (mevcut koyu kart/sekme dili), BotDetail'e ⚔ sekmesi, TasksPanel komutları (`attack`, `mobtemizle`, `kac`, `loot`).
10. **Test:** `scripts/combat-test.mjs` — silah mantığı, config, 400 redleri, stop-combat, online attack denemesi; **tümü geçti**.
11. **Typecheck:** server + web temiz.

**Sorunlar ve çözümler:**

| Sorun | Çözüm |
|---|---|
| `tsc` NodeNext: dynamic `import("../movement")` uzantı istiyor | Statik import `runGoto` / `goals` |
| `Entity.eyeHeight` tipte yok | `(bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62` |
| flying-squid entity yok → PvP fiziği test edilemez | API/mantık testi + TODO `✅*` + Paper checklist (önceki AI ile aynı dürüstlük) |
| pvp eklentisi §3'te yazıyor, §14 custom diyor | Custom RealismLayer uygulandı; §14'e net karar satırı |

**Bilerek bırakılan borçlar:** Paper'da savuş/LOS/creeper standoff kabulü; ok/yay Backlog; armor-manager hâlâ bannedItems'ı otomatik delmesin diye ayrı (Faz 5 borcu).

**Sıradaki faz:** **Faz 7 — Hayatta kalma** (yeme, av, pişirme). Faz 7 av için dövüş API'sini kullanır; halka arama hâlâ Faz 8'de (yakın çevre avı ile başlanabilir).

**Commit:** `fd5acbd` faz6 (önceki) + bu oturumda faz7–12.

### 2026-07-15 — Grok 4.5 (xAI) — Faz 6 denetim + Faz 7–12 çekirdek + full-suite

**Faz 6 yeniden denetim (olasılıklar):**

| Olasılık | Sonuç | Aksiyon |
|---|---|---|
| `goals` import silinmiş, approachEntity kırık | TS hatası | `goals` geri eklendi |
| `eyeHeight` / blockAt(2arg) | tip hatası | düzeltildi |
| `detach` lastDeath silmiyor | doğru (loot için) | korundu |
| armor-manager banned deler | hâlâ risk | silah seçici banned uyuyor; zırh borcu § not |
| bots.json eski şema | crash riski | `mergeConfig(default, loaded)` boot migrasyonu |
| loot-death death yok | 400 | test ✓ |
| boş attack | 400 | test ✓ |
| entity yok attack | fail/log | flying-squid beklenen |

**Faz 7–12 uygulanan dosyalar (özet):**

- `modules/survival/*` — auto-eat, hunt, cook, acquire-food, SurvivalPanel
- `modules/gather/*` — ringSearch, wood, drops, mine, GatherCraftPanel
- `modules/craft/*` — plan + craft görevi + craft-plan API
- `modules/world/memory.ts` — sandık/cevher json
- `modules/automation/RuleEngine.ts` — kurallar, şablonlar, Automations.tsx
- TaskQueue pause/resume; deposit/withdraw/fetch
- Settings.tsx; BotDetail sekmeleri Yaşam/İş
- `scripts/full-suite.mjs`, `scripts/combat-test.mjs`

**Testler (2026-07-15 bu oturum, hepsi exit 0):**

1. `node scripts/combat-test.mjs` ✅  
2. `node scripts/full-suite.mjs` ✅ (rules, worldMemory, tüm action enqueue, craft-plan, pause/resume, online goto)  
3. `node scripts/smoke.mjs` ✅ (Faz1–3 regress)  
4. `npm run typecheck` ✅ server+web  

**Sorunlar / çözümler (7–12):**

| Sorun | Çözüm |
|---|---|
| NodeNext dynamic import uzantı | statik import |
| bot.craft 3. arg `null` tipi | `undefined` |
| AttackResult reason narrowing | `!res.ok && res.reason` |
| openChest API | openContainer + best-effort deposit/withdraw |
| Craft nested enqueue race | gather.runCollectWood inline |
| RuleEngine wait parantez | syntax fix |
| flying-squid entity/window | dürüst ✅* Paper borçları |

**Bilerek Backlog'da kalan:** prismarine-viewer, Discord, multi-user, EN i18n, 5 bot 1 saat sızıntı, drag-drop envanter, node kural editörü, armor-manager banned soft-filter.

**Sıradaki devralan:** Paper saha listesi (Faz4–10 fizik ✅* maddeleri); Backlog ürün cilası.

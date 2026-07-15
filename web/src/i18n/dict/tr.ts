import type { MessageTree } from "../types";

export const tr: MessageTree = {
  app: {
    name: "CaYa Bot Panel",
    roadmap: "Yol haritası: TODO.md",
    principleI1: "Sistem mesajları asla oyun sohbetine yazılmaz (İ1)."
  },
  nav: {
    panel: "Panel",
    automations: "Otomasyonlar",
    schematics: "Yapı şemaları",
    servers: "Sunucular",
    settings: "Ayarlar"
  },
  connection: {
    connected: "Bağlı",
    disconnected: "Bağlantı yok",
    apiConnected: "API bağlantısı",
    online: "Çevrimiçi",
    offline: "Çevrimdışı",
    none: "Yok"
  },
  common: {
    save: "Kaydet",
    cancel: "İptal",
    delete: "Sil",
    edit: "Düzenle",
    add: "Ekle",
    refresh: "Yenile",
    start: "Başlat",
    stop: "Durdur",
    yes: "Evet",
    no: "Hayır",
    loading: "Yükleniyor…",
    error: "Hata",
    success: "Başarılı",
    confirm: "Onayla",
    back: "Geri",
    search: "Ara",
    apply: "Uygula",
    reset: "Sıfırla",
    close: "Kapat",
    enabled: "Açık",
    disabled: "Kapalı",
    open: "Açık",
    closed: "Kapalı",
    optional: "opsiyonel",
    unknown: "bilinmiyor",
    all: "Hepsi",
    none: "Yok"
  },
  language: {
    title: "Dil",
    label: "Arayüz dili",
    auto: "Sistem dili",
    autoHint: "İşletim sistemi / tarayıcı dilini kullan (tr* ise Türkçe, aksi İngilizce)",
    en: "İngilizce",
    tr: "Türkçe",
    current: "Aktif dil",
    systemDetected: "Algılanan sistem dili",
    fallbackNote: "Sistem dili alınamazsa veya desteklenmeyen dilse İngilizce kullanılır."
  },
  status: {
    stopped: "Durduruldu",
    connecting: "Bağlanıyor",
    online: "Çevrimiçi",
    reconnecting: "Yeniden bağlanıyor",
    kicked: "Atıldı",
    error: "Hata"
  },
  dashboard: {
    title: "Botlar",
    onlineCount: "{online}/{total} çevrimiçi",
    startAll: "▶ Tümünü Başlat",
    stopAll: "■ Tümünü Durdur",
    addBot: "+ Bot Ekle",
    empty: 'Henüz bot yok. "+ Bot Ekle" ile ilk botunu oluştur.',
    startingAll: "Botlar kademeli başlatılıyor…",
    stoppingAll: "Tüm botlar durduruluyor",
    systemLogs: "Sistem Logları",
    allChat: "Tüm sohbet"
  },
  settings: {
    title: "Ayarlar",
    botsOnline: "{online}/{total} bot çevrimiçi",
    system: "Sistem",
    botCount: "Bot sayısı",
    serverProfiles: "Sunucu profili",
    listening: "Dinleme",
    listeningValue: "127.0.0.1 (localhost)",
    roles: "Roller (preset)",
    rolesHint: "Tek tıkla kural paketleri — Otomasyonlar sayfasındaki şablonlardan eklenir, sonra düzenlenebilir.",
    roleLogger: "Oduncu",
    roleMiner: "Madenci",
    roleGuard: "Koruma",
    roleGatherer: "Toplayıcı",
    roleCourier: "Kurye",
    backlogNote: "Anti-AFK, 3D viewer, Discord webhook → Backlog. Kritik olaylar Log paneli + toast ile izlenir.",
    principles: "Temel ilkeler",
    p1: "Sistem mesajları asla oyun sohbetine yazılmaz (sadece panel Log).",
    p2: "Dövüş RealismLayer kapatılamaz; menzil / LOS / tempo zorlanır.",
    p3: "Sohbet otomasyonları varsayılan yetkili oyuncu listesi.",
    p6: "Görev önceliği: hayatta kal > savunma > kullanıcı > otomasyon."
  },
  servers: {
    title: "Sunucular",
    add: "+ Sunucu ekle",
    empty: "Henüz sunucu profili yok.",
    host: "Host",
    port: "Port",
    version: "Sürüm",
    name: "Ad",
    note: "Not",
    save: "Profili kaydet",
    deleteConfirm: "{name} sunucu profili silinsin mi?"
  },
  schematics: {
    title: "Yapı şemaları",
    upload: "Yükle",
    empty: "Henüz şema yok.",
    materials: "Malzemeler",
    blocks: "blok",
    deleteConfirm: "{name} şeması silinsin mi?"
  },
  automations: {
    title: "Otomasyonlar",
    add: "+ Yeni kural",
    empty: "Henüz kural yok.",
    enabled: "Açık",
    disabled: "Kapalı"
  },
  botDetail: {
    notFound: "Bot bulunamadı.",
    backToPanel: "← Panele dön",
    autostart: "Otomatik başlat",
    start: "▶ Başlat",
    stop: "■ Durdur",
    delete: "Sil",
    deleteConfirm: "{name} silinsin mi? Bu işlem geri alınamaz.",
    deleted: "{name} silindi",
    resetWork: "↺ İşleri sıfırla",
    resetWorkTitle: "Görev, hareket, dövüş ve inşaatı bırak — bot bağlı kalır",
    resetWorkConfirm:
      "{name} — tüm işler sıfırlansın mı?\n\nGörev kuyruğu, hareket, takip/saldırı/koruma, inşaat ve pathfinder bırakılır.\nBot sunucuda bağlı kalır (yeniden başlatma gerekmez).",
    resetWorkDone: "Tüm işler sıfırlandı — bot hazır",
    health: "Can",
    food: "Açlık",
    level: "Seviye {n}",
    tabs: {
      chat: "💬 Sohbet",
      logs: "📋 Loglar",
      inventory: "🎒 Envanter",
      tasks: "📌 Görevler",
      combat: "⚔️ Dövüş",
      survival: "🍖 Yaşam",
      work: "🪓 İş",
      build: "🏗️ Yapı"
    }
  },
  tasks: {
    run: "Çalıştır",
    stop: "■ Durdur",
    reset: "↺ Sıfırla",
    resetConfirm:
      "Tüm işler sıfırlansın mı?\nGörev, hareket, takip/saldırı, inşaat bırakılır — bot bağlı kalır.",
    resetDone: "Tüm işler sıfırlandı",
    stopped: "Hareket durduruldu",
    cmdHelp: "Komut: goto 100 64 -200",
    cmdPlaceholder: "Komut: goto 100 64 -200",
    quickMove: "Hızlı hareket",
    go: "Git",
    playerPlaceholder: "Oyuncu adı",
    goToPlayer: "Oyuncuya git"
  },
  combat: {
    title: "Dövüş",
    offlineHint: "Bot çevrimdışı — ayarlar yine kaydedilir; dövüş görevleri online iken çalışır.",
    status: "Durum",
    leaveCombat: "■ Dövüşü bırak",
    flee: "Kaç",
    modes: {
      idle: "Boşta",
      attacking: "Saldırıyor",
      defending: "Savunuyor",
      fleeing: "Kaçıyor",
      protecting: "Koruyor"
    },
    target: "Hedef",
    noTarget: "Aktif hedef yok",
    selfDefense: "Öz savunma · boşta",
    selfDefenseHint:
      "Görev yokken veya takipte menzile zombie vb. gelince savaşır; can eşiğin altına inince kaçar. Anlık uygulanır.",
    defendOff: "Kapalı",
    defendMob: "Mob",
    defendPlayer: "Oyuncu",
    defendAll: "Hepsi",
    scanRange: "Tarama menzili (blok)",
    fleeHealth: "Kaçış can eşiği",
    chaseDistance: "Kovalama mesafesi",
    cleaveTitle: "Ara vuruş · kenetlenmişken",
    cleaveOn: "açık",
    cleaveOff: "kapalı",
    cleaveHint:
      "Ana hedefe kilitliyken (saldırı / savunma) çok yakındaki mob veya sana hasar veren oyuncu da menzildeyse ara vuruş alır. Ana hedef değişmez.",
    cleaveToggleOn: "Ara vuruş açık",
    cleaveToggleOff: "Ara vuruş kapalı",
    cleaveMobs: "Mob",
    cleavePlayers: "Hasar veren oyuncu",
    cleaveRange: "Ara vuruş menzili (blok)",
    escort: "Eşlik koruması",
    escortNone: "kimse yok → Yakındaki oyuncular · Koru",
    combatLeft: "Dövüş bırakıldı"
  },
  build: {
    title: "Yapı inşaat",
    start: "▶ İnşa et",
    stop: "■ Durdur",
    collectMissing: "Eksikleri topla",
    materials: "Malzemeler",
    live: "canlı",
    now: "Şu an",
    missing: "{n} eksik",
    phases: {
      idle: "Boşta",
      preparing: "Hazırlanıyor",
      acquiring: "Malzeme toplanıyor",
      building: "İnşa ediliyor",
      cleanup: "Scaffold temizlik",
      done: "Tamam",
      failed: "Hata",
      cancelled: "İptal"
    },
    stopped: "İnşaat durduruldu"
  },
  survival: {
    title: "Yaşam",
    autoEat: "Otomatik ye",
    fallGuard: "Düşüş kurtarma (MLG)"
  },
  work: {
    title: "Toplama & üretim",
    collectWood: "Odun topla",
    mine: "Maden",
    craft: "Üret"
  },
  inventory: {
    title: "Envanter",
    empty: "Envanter boş",
    equip: "Kuşan",
    drop: "At"
  },
  chat: {
    placeholder: "Mesaj…",
    send: "Gönder",
    empty: "Henüz mesaj yok"
  },
  logs: {
    title: "Loglar",
    empty: "Henüz log yok",
    clear: "Görünümü temizle"
  },
  nearby: {
    title: "Yakındaki oyuncular",
    follow: "Takip",
    attack: "Saldır",
    protect: "Koru",
    empty: "Yakında oyuncu yok"
  },
  addBot: {
    title: "Bot ekle",
    username: "Kullanıcı adı",
    server: "Sunucu",
    create: "Oluştur"
  },
  toast: {
    saved: "Kaydedildi",
    failed: "Başarısız"
  }
};

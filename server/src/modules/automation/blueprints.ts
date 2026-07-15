import type { AutomationRule } from "./RuleEngine";

/** Blueprint = hazır otomasyon kartı (kategori + açıklama + kural) */
export interface RuleBlueprint {
  id: string;
  name: string;
  category: string;
  description: string;
  rule: Partial<AutomationRule>;
}

export const RULE_BLUEPRINTS: RuleBlueprint[] = [
  // ── Sohbet / komut ──────────────────────────────────────────
  {
    id: "cmd-gel",
    name: "Komut: /gel",
    category: "Sohbet & Komut",
    description: "Yetkili /gel yazınca bot yanına gelir. Slash komut olarak algılanır.",
    rule: {
      name: "Komut: /gel",
      trigger: { type: "chat", pattern: "gel", match: "command", from: "authorized", commandPrefix: "/" },
      actions: [
        { type: "goto", player: "{player}" },
        { type: "panel_notify", message: "{player} → /gel", level: "info" }
      ],
      cooldownMs: 2000
    }
  },
  {
    id: "cmd-takip",
    name: "Komut: /takip",
    category: "Sohbet & Komut",
    description: "Yetkili /takip yazınca bot takip eder.",
    rule: {
      name: "Komut: /takip",
      trigger: { type: "chat", pattern: "takip", match: "command", from: "authorized", commandPrefix: "/" },
      actions: [{ type: "follow", player: "{player}", distance: 3 }],
      cooldownMs: 2000
    }
  },
  {
    id: "cmd-dur",
    name: "Komut: /dur",
    category: "Sohbet & Komut",
    description: "Yetkili /dur → tüm işleri bırak (pathfinder + kuyruk).",
    rule: {
      name: "Komut: /dur",
      trigger: { type: "chat", pattern: "dur|stop", match: "command", from: "authorized", commandPrefix: "/" },
      actions: [
        { type: "reset-work" },
        { type: "panel_notify", message: "{player} /dur — işler sıfırlandı", level: "warn" }
      ],
      cooldownMs: 1500
    }
  },
  {
    id: "cmd-koru",
    name: "Komut: /koru",
    category: "Sohbet & Komut",
    description: "Yetkili /koru → o kişiyi koru (eşlik).",
    rule: {
      name: "Komut: /koru",
      trigger: { type: "chat", pattern: "koru", match: "command", from: "authorized", commandPrefix: "/" },
      actions: [
        { type: "protect", player: "{player}" },
        { type: "panel_notify", message: "Koruma: {player}", level: "success" }
      ],
      cooldownMs: 2000
    }
  },
  {
    id: "cmd-saldir",
    name: "Komut: /saldir <isim>",
    category: "Sohbet & Komut",
    description: "Yetkili /saldir Steve → argüman oyuncuya saldır.",
    rule: {
      name: "Komut: /saldir",
      trigger: { type: "chat", pattern: "saldir|saldır|attack", match: "command", from: "authorized", commandPrefix: "/" },
      actions: [
        { type: "attack", player: "{arg0}" },
        { type: "panel_notify", message: "Saldırı hedefi: {arg0}", level: "warn" }
      ],
      cooldownMs: 3000
    }
  },
  {
    id: "chat-gel-contains",
    name: "Sohbet: gel (içerir)",
    category: "Sohbet & Komut",
    description: "Yetkili mesajında “gel” geçerse bot yanına gider (klasik).",
    rule: {
      name: "Gel komutu",
      trigger: { type: "chat", pattern: "gel", match: "contains", from: "authorized" },
      actions: [{ type: "goto", player: "{player}" }],
      cooldownMs: 2000
    }
  },
  {
    id: "chat-person",
    name: "Belirli kişi yazarsa gel",
    category: "Sohbet & Komut",
    description: "Sadece belirtilen oyuncu “gel” yazınca tetiklenir (formda ismi doldur).",
    rule: {
      name: "Belirli kişi: gel",
      trigger: { type: "chat", pattern: "gel", match: "contains", from: "anyone", player: "" },
      actions: [{ type: "goto", player: "{player}" }],
      cooldownMs: 2000
    }
  },
  {
    id: "chat-sa",
    name: "sa → as",
    category: "Sohbet & Komut",
    description: "Herkes “sa” yazınca “as {player}” cevabı.",
    rule: {
      name: "Hoş geldin (sa)",
      trigger: { type: "chat", pattern: "sa", match: "contains", from: "anyone" },
      actions: [{ type: "send_chat", text: "as {player}" }],
      cooldownMs: 10_000,
      maxTriggersPerMinute: 3
    }
  },

  // ── Savunma / koruma ────────────────────────────────────────
  {
    id: "retaliate-player",
    name: "Oyuncu saldırınca karşılık",
    category: "Savunma & Koruma",
    description: "Bot’a oyuncu vurursa saldırgana karşılık verir.",
    rule: {
      name: "Saldırıya karşılık",
      trigger: { type: "attacked", source: "player" },
      actions: [
        { type: "attack", player: "{attacker}" },
        { type: "panel_notify", message: "{attacker} saldırdı — karşılık", level: "warn" }
      ],
      cooldownMs: 5000
    }
  },
  {
    id: "flee-mob-low-hp",
    name: "Mob + can düşük → kaç",
    category: "Savunma & Koruma",
    description: "Mob vururken can ≤10 ise kaç.",
    rule: {
      name: "Mob saldırısında kaç",
      trigger: { type: "attacked", source: "mob" },
      conditions: [{ type: "health_below", threshold: 10 }],
      actions: [{ type: "flee" }, { type: "panel_notify", message: "Mob — kaçış", level: "warn" }],
      cooldownMs: 8000
    }
  },
  {
    id: "critical-flee",
    name: "Can kritik → kaç",
    category: "Savunma & Koruma",
    description: "Can eşiğin altına düşünce kaç ve paneli uyar.",
    rule: {
      name: "Can kritik — kaç",
      trigger: { type: "health_below", threshold: 6 },
      actions: [{ type: "flee" }, { type: "panel_notify", message: "Can kritik", level: "error" }],
      cooldownMs: 10_000
    }
  },
  {
    id: "clear-mobs-attacked",
    name: "Mob vurunca temizle",
    category: "Savunma & Koruma",
    description: "Mob saldırınca menzildeki mobları temizle.",
    rule: {
      name: "Mob saldırısı → temizle",
      trigger: { type: "attacked", source: "mob" },
      conditions: [{ type: "online" }],
      actions: [{ type: "clear-mobs", radius: 12 }],
      cooldownMs: 15_000
    }
  },
  {
    id: "nearby-auth-greet",
    name: "Yetkili yaklaşınca selam",
    category: "Savunma & Koruma",
    description: "Yetkili oyuncu 8 blok yakına gelince sa yazar.",
    rule: {
      name: "Yakındaki yetkiliye selam",
      trigger: { type: "player_nearby", radius: 8, from: "authorized" },
      actions: [{ type: "send_chat", text: "sa {player}" }],
      cooldownMs: 120_000,
      maxTriggersPerMinute: 2
    }
  },
  {
    id: "protect-on-chat",
    name: "“koru beni” → eşlik koruma",
    category: "Savunma & Koruma",
    description: "Yetkili sohbette “koru” derse koruma açılır.",
    rule: {
      name: "Beni koru",
      trigger: { type: "chat", pattern: "koru", match: "contains", from: "authorized" },
      actions: [
        { type: "protect", player: "{player}" },
        { type: "set_defend", mode: "all" }
      ]
    }
  },

  // ── Toplama / üretim ────────────────────────────────────────
  {
    id: "lumberjack",
    name: "Oduncu (2 dk)",
    category: "Toplama & Üretim",
    description: "Boştayken her 2 dakikada odun topla.",
    rule: {
      name: "Oduncu",
      trigger: { type: "interval", everyMs: 120_000 },
      conditions: [{ type: "task_idle" }, { type: "online" }],
      actions: [{ type: "collect", count: 32, block: "oak_log" }]
    }
  },
  {
    id: "iron-miner",
    name: "Demir madencisi",
    category: "Toplama & Üretim",
    description: "Boştayken demir madeni ara.",
    rule: {
      name: "Demir madencisi",
      trigger: { type: "interval", everyMs: 180_000 },
      conditions: [{ type: "task_idle" }],
      actions: [{ type: "mine", ore: "iron", count: 16, mode: "legit" }]
    }
  },
  {
    id: "low-wood",
    name: "Odun azsa topla",
    category: "Toplama & Üretim",
    description: "oak_log < 16 ise toplama görevi.",
    rule: {
      name: "Odun azsa topla",
      trigger: { type: "item_count", item: "oak_log", comparison: "lt", threshold: 16 },
      conditions: [{ type: "task_idle" }],
      actions: [{ type: "collect", count: 32, block: "oak_log" }],
      cooldownMs: 60_000
    }
  },
  {
    id: "craft-sticks",
    name: "Stick üret (azsa)",
    category: "Toplama & Üretim",
    description: "stick < 8 ise craft.",
    rule: {
      name: "Stick üret (azsa)",
      trigger: { type: "item_count", item: "stick", comparison: "lt", threshold: 8 },
      conditions: [{ type: "task_idle" }],
      actions: [{ type: "craft", item: "stick", count: 16 }],
      cooldownMs: 45_000
    }
  },
  {
    id: "inv-full",
    name: "Envanter dolu → depo",
    category: "Toplama & Üretim",
    description: "Envanter dolunca paneli uyar ve depoya bırak.",
    rule: {
      name: "Envanter dolu uyarısı",
      trigger: { type: "inventory_full" },
      actions: [
        { type: "panel_notify", message: "Envanter doldu", level: "warn" },
        { type: "deposit" }
      ],
      cooldownMs: 30_000
    }
  },
  {
    id: "pickup-drops",
    name: "Periyodik yer eşyası",
    category: "Toplama & Üretim",
    description: "Her 3 dk yerdeki eşyaları topla.",
    rule: {
      name: "Yerdeki eşya turu",
      trigger: { type: "interval", everyMs: 180_000 },
      conditions: [{ type: "task_idle" }, { type: "online" }],
      actions: [{ type: "collect_drops", radius: 24 }]
    }
  },

  // ── Yaşam ───────────────────────────────────────────────────
  {
    id: "food-guard",
    name: "Yemek nöbetçisi",
    category: "Yaşam",
    description: "Açlık düşükse ye + yemek edin.",
    rule: {
      name: "Yemek nöbetçisi",
      trigger: { type: "food_below", threshold: 10 },
      actions: [{ type: "eat" }, { type: "acquire_food" }],
      cooldownMs: 15_000
    }
  },
  {
    id: "hunt-hungry",
    name: "Açken avlan",
    category: "Yaşam",
    description: "Açlık çok düşükse avlan.",
    rule: {
      name: "Açken avlan",
      trigger: { type: "food_below", threshold: 8 },
      conditions: [{ type: "task_idle" }],
      actions: [{ type: "hunt", radius: 32 }],
      cooldownMs: 45_000
    }
  },
  {
    id: "spawn-eat",
    name: "Spawn olunca ye",
    category: "Yaşam",
    description: "Bot spawn/respawn sonrası yemek dene.",
    rule: {
      name: "Spawn — ye",
      trigger: { type: "bot_spawned" },
      actions: [{ type: "eat" }],
      cooldownMs: 5000
    }
  },
  {
    id: "died-notify",
    name: "Ölüm bildirimi",
    category: "Yaşam",
    description: "Bot ölünce paneli uyar.",
    rule: {
      name: "Bot öldü",
      trigger: { type: "bot_died" },
      actions: [{ type: "panel_notify", message: "Bot öldü — loot?", level: "error" }],
      cooldownMs: 3000
    }
  },

  // ── Sosyal ──────────────────────────────────────────────────
  {
    id: "join-welcome",
    name: "Giren oyuncuya hoş geldin",
    category: "Sosyal",
    description: "Tab’a yeni giren oyuncuya sohbet mesajı.",
    rule: {
      name: "Giriş karşılama",
      trigger: { type: "player_joined" },
      actions: [{ type: "send_chat", text: "hoş geldin {player}" }],
      cooldownMs: 5000,
      maxTriggersPerMinute: 6
    }
  },
  {
    id: "leave-bye",
    name: "Çıkan oyuncuya güle güle",
    category: "Sosyal",
    description: "Tab’dan çıkan oyuncuyu panelde logla.",
    rule: {
      name: "Çıkış log",
      trigger: { type: "player_left" },
      actions: [{ type: "panel_notify", message: "{player} çıktı", level: "info" }],
      cooldownMs: 2000
    }
  },

  // ── Görev zinciri ───────────────────────────────────────────
  {
    id: "task-fail-notify",
    name: "Görev fail → panel",
    category: "Görev",
    description: "Herhangi bir görev başarısız olunca paneli uyar.",
    rule: {
      name: "Görev başarısız",
      trigger: { type: "task_failed" },
      actions: [{ type: "panel_notify", message: "Görev fail: {label}", level: "error" }],
      cooldownMs: 2000
    }
  },
  {
    id: "task-done-mine-next",
    name: "Toplama bitince depola",
    category: "Görev",
    description: "collect/mine bittikten sonra depoya bırakmayı dene.",
    rule: {
      name: "Toplama bitti → depo",
      trigger: { type: "task_done", taskType: "collect-wood" },
      actions: [{ type: "deposit" }],
      cooldownMs: 10_000
    }
  },

  // ── Eşya envanter / toplama ─────────────────────────────────
  {
    id: "need-cobble",
    name: "Cobble azsa topla",
    category: "Eşya & Envanter",
    description: "cobblestone < 32 ise dünyadan cobble topla (toplamalı).",
    rule: {
      name: "Cobble azsa topla",
      trigger: { type: "item_count", item: "cobblestone", comparison: "lt", threshold: 32 },
      conditions: [{ type: "task_idle" }, { type: "online" }],
      actions: [
        { type: "collect_item", item: "cobblestone", count: 64 },
        { type: "panel_notify", message: "Cobble eksik — toplama başlatıldı", level: "info" }
      ],
      cooldownMs: 90_000
    }
  },
  {
    id: "gained-diamond",
    name: "Elmas envantere gelince bildir",
    category: "Eşya & Envanter",
    description: "diamond / diamond_ore adedi artınca panel bildirimi (aldı / topladı).",
    rule: {
      name: "Elmas geldi",
      trigger: { type: "item_gained", item: "diamond", threshold: 1 },
      actions: [
        { type: "panel_notify", message: "Elmas envantere geldi (+{delta}) · toplam {count}", level: "success" },
        { type: "send_chat", text: "elmas aldım!" }
      ],
      cooldownMs: 5000
    }
  },
  {
    id: "gained-any-log",
    name: "Odun gelince craft dene",
    category: "Eşya & Envanter",
    description: "Herhangi _log envantere girince stick üretmeyi dene.",
    rule: {
      name: "Odun geldi → stick",
      trigger: { type: "item_gained", item: "log", threshold: 1 },
      conditions: [{ type: "task_idle" }],
      actions: [{ type: "craft", item: "stick", count: 8 }],
      cooldownMs: 30_000
    }
  },
  {
    id: "collect-success-oak",
    name: "Toplama görevi bitince depo",
    category: "Eşya & Envanter",
    description: "collect-wood / collect-block başarıyla bitince depoya bırak.",
    rule: {
      name: "Toplama bitti → depo",
      trigger: { type: "task_done", taskType: "collect-wood|collect-block" },
      actions: [
        { type: "panel_notify", message: "Toplama tamam: {label}", level: "success" },
        { type: "deposit" }
      ],
      cooldownMs: 8000
    }
  },
  {
    id: "any-gather-success",
    name: "Herhangi kaynak toplama bitti",
    category: "Eşya & Envanter",
    description: "collect / mine / craft görevi başarıyla bitince paneli bilgilendir.",
    rule: {
      name: "Kaynak görevi bitti",
      trigger: { type: "task_done", taskType: "collect|mine|craft|gather" },
      actions: [{ type: "panel_notify", message: "Görev tamam: {taskType} · {label}", level: "success" }],
      cooldownMs: 3000
    }
  },
  {
    id: "mine-success",
    name: "Maden görevi bitince bildir",
    category: "Eşya & Envanter",
    description: "mine görevi başarıyla bitince panel + yer eşyası topla.",
    rule: {
      name: "Maden bitti",
      trigger: { type: "task_done", taskType: "mine" },
      actions: [
        { type: "panel_notify", message: "Maden bitti: {label}", level: "success" },
        { type: "collect_drops", radius: 16 }
      ],
      cooldownMs: 5000
    }
  },
  {
    id: "cmd-topla",
    name: "Komut: /topla <eşya> [adet]",
    category: "Sohbet & Komut",
    description: "Yetkili /topla cobblestone 32 → o eşyayı topla.",
    rule: {
      name: "Komut: /topla",
      trigger: {
        type: "chat",
        pattern: "topla|collect",
        match: "command",
        from: "authorized",
        commandPrefix: "/"
      },
      actions: [
        { type: "collect_item", item: "{arg0}", count: "{arg1}" },
        { type: "panel_notify", message: "Topla: {arg0} ×{arg1}", level: "info" }
      ],
      cooldownMs: 3000
    }
  }
];

/** Eski API uyumu: isim listesi */
export function blueprintNames(): string[] {
  return RULE_BLUEPRINTS.map((b) => b.name);
}

export function findBlueprint(nameOrId: string): RuleBlueprint | undefined {
  const q = nameOrId.toLowerCase();
  return RULE_BLUEPRINTS.find((b) => b.id === nameOrId || b.name.toLowerCase() === q);
}

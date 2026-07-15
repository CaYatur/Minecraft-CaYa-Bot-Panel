# 🐺 CaYa Bot Panel

Tarayıcıdan çalışan Minecraft çoklu-bot kontrol paneli (mineflayer tabanlı).
Ayrıntılı yol haritası ve geliştirme kuralları için: **[TODO.md](TODO.md)** (tek doğruluk kaynağı).

## Lisans

[MIT](LICENSE) © 2026 ÇAĞAN TURGUT (CaYatur)

## Kurulum

Gereksinim: Node.js ≥ 18 (öneri: 22+).

```bash
npm install
```

## Çalıştırma (geliştirme)

```bash
npm run dev
```

- Panel: http://localhost:3000
- API + Socket.IO: http://localhost:3001 (panel, vite proxy üzerinden aynı origin'den erişir)

## Test sunucusu (lokal, offline)

Gerçek bir Minecraft sunucun yoksa hızlı deneme için JS tabanlı test sunucusu:

```bash
npm run testserver   # 127.0.0.1:25566 üzerinde offline test sunucusu açar
npm run smoke        # panel API'si üzerinden uçtan uca duman testi
```

Gerçek testler için PaperMC kurulumu: `test-server/README.md`.

## Komutlar

| Komut | İş |
|---|---|
| `npm run dev` | Server + web panel birlikte (watch) |
| `npm run typecheck` | İki workspace'te de tip kontrolü |
| `npm run build` | Üretim derlemesi |
| `npm run smoke` | Uçtan uca duman testi (test sunucusu açıkken) |

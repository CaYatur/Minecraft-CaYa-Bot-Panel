# Test Sunucuları

## 1) Hızlı yol — flying-squid (Java gerekmez)

```bash
npm run testserver
```

- Adres: `127.0.0.1:25566`, offline-mode, sürüm **1.16.1**, superflat dünya.
- Bağlantı, sohbet, hareket ve temel blok işlemleri test edilebilir.
- Sınırlar: eski sürüm (1.16.1), eksik oyun mekanikleri (fırın/craft UI, mob AI zayıf).
  Faz 6+ kabul testleri için gerçek sunucu şart.

## 2) Gerçek yol — PaperMC (önerilen: 1.20.4)

1. Java 17+ kur (`java -version` ile doğrula).
2. https://papermc.io/downloads adresinden 1.20.4 jar'ını indir, bu klasöre `paper.jar` adıyla koy
   (jar dosyaları git'e girmez).
3. İlk çalıştırma: `java -Xmx2G -jar paper.jar nogui` → `eula.txt` içinde `eula=true` yap.
4. `server.properties` içinde:
   - `online-mode=false`  (offline botlar için şart)
   - `spawn-protection=0` (botlar spawn'da blok kırabilsin)
5. Tekrar başlat. Panelde sunucu profili: `127.0.0.1:25565`, sürüm `1.20.4`.

> Not: EULA'yı kabul etmek senin kararın; kendi makinede kendi test sunucun için normaldir.

## 3) Anti-cheat kontrolü — Paper + ViaVersion + GrimAC (1.21.2+ hareket paketleri)

Vanilla sunucu botun hareket paketlerini sorgulamaz; Grim gibi anti-cheat'ler ise her
tick'i yeniden hesaplar. 1.21.2+ hareket düzeltmeleri (`server/src/core/protocolCompat.ts`)
yalnızca böyle bir sunucuda gerçekten doğrulanır (issue #34).

1. Java: 26.1 için **Java 25**, 1.21.x için Java 21.
2. Bu klasörde ayrı bir klasöre Paper jar'ını koy (ör. 1.21.11), `plugins/` içine
   **ViaVersion** (GitHub releases) ve **GrimAC** (Modrinth) jar'larını koy.
3. `server.properties`:
   ```
   online-mode=false
   spawn-protection=0
   server-port=25571
   level-type=minecraft\:flat
   enable-rcon=true
   rcon.port=25581
   rcon.password=<kendi şifren>
   ```
4. `plugins/GrimAC/config.yml` içinde `verbose: print-to-console: true` yapınca
   her uyarı sunucu konsoluna düşer.
5. Panelde sunucu profili `127.0.0.1:25571`, sürüm `26.1` (ViaVersion çevirir). Botu
   bir hedefe gönder (goto/follow) ve konsolu izle:
   - Düzeltme yokken: `TickTimer`, `GroundSpoof`, `Simulation` uyarıları ve bot yerinden kıpırdamaz.
   - Düzeltmeyle: uyarı yok, bot yürür.
6. Karşılaştırma için paneli `CAYA_PROTOCOL_COMPAT=off` ortam değişkeniyle başlat.
   Bir botun tick tick ne gönderdiğini görmek için ona op verip `/grim debug <bot>` çalıştır.

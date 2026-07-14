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

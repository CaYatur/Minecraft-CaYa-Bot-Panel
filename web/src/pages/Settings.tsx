import { useAppStore } from "../stores/useAppStore";

/** Faz 12 — Ayarlar. Sayfa dili: Servers.tsx. */
export function Settings() {
  const bots = useAppStore((s) => s.bots);
  const servers = useAppStore((s) => s.servers);
  const connected = useAppStore((s) => s.connected);
  const list = Object.values(bots);
  const onlineCount = list.filter((b) => b.status === "online").length;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">Ayarlar</h1>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
          {onlineCount}/{list.length} bot çevrimiçi
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Sistem</div>
          <ul className="space-y-2 text-sm text-zinc-300">
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">API bağlantısı</span>
              <span className="flex items-center gap-1.5">
                <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
                <span className={connected ? "text-emerald-300" : "text-red-300"}>{connected ? "Bağlı" : "Yok"}</span>
              </span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">Bot sayısı</span>
              <span className="mono text-zinc-200">{list.length}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">Sunucu profili</span>
              <span className="mono text-zinc-200">{servers.length}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">Dinleme</span>
              <span className="mono text-xs text-zinc-400">127.0.0.1 (localhost)</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">Dil</span>
              <span className="text-zinc-300">Türkçe (varsayılan)</span>
            </li>
          </ul>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Roller (preset)</div>
          <p className="mb-3 text-xs leading-relaxed text-zinc-500">
            Tek tıkla kural paketleri — Otomasyonlar sayfasındaki şablonlardan eklenir, sonra düzenlenebilir.
          </p>
          <div className="flex flex-wrap gap-2">
            {["Oduncu", "Madenci", "Koruma", "Toplayıcı", "Kurye"].map((r) => (
              <span
                key={r}
                className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-1.5 text-xs text-zinc-400"
              >
                {r}
              </span>
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-zinc-600">
            Anti-AFK, 3D viewer, Discord webhook → Backlog. Kritik olaylar Log paneli + toast ile izlenir.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Temel ilkeler</div>
        <ul className="space-y-1.5 text-sm text-zinc-400">
          <li>
            <span className="text-zinc-300">İ1</span> — Sistem mesajları asla oyun sohbetine yazılmaz (sadece panel Log).
          </li>
          <li>
            <span className="text-zinc-300">İ2</span> — Dövüş RealismLayer kapatılamaz; menzil / LOS / tempo zorlanır.
          </li>
          <li>
            <span className="text-zinc-300">İ3</span> — Sohbet otomasyonları varsayılan yetkili oyuncu listesi.
          </li>
          <li>
            <span className="text-zinc-300">İ6</span> — Görev önceliği: hayatta kal &gt; savunma &gt; kullanıcı &gt; otomasyon.
          </li>
        </ul>
      </div>
    </div>
  );
}

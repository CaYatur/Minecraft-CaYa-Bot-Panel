import { useAppStore } from "../stores/useAppStore";

export function Settings() {
  const bots = useAppStore((s) => s.bots);
  const servers = useAppStore((s) => s.servers);
  const connected = useAppStore((s) => s.connected);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <h1 className="text-xl font-bold text-zinc-100">Ayarlar</h1>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Sistem</div>
          <ul className="space-y-1 text-sm text-zinc-300">
            <li>
              API bağlantısı:{" "}
              <span className={connected ? "text-emerald-400" : "text-red-400"}>{connected ? "Bağlı" : "Yok"}</span>
            </li>
            <li>
              Bot sayısı: <span className="mono">{Object.keys(bots).length}</span>
            </li>
            <li>
              Sunucu profili: <span className="mono">{servers.length}</span>
            </li>
            <li>Dinleme: localhost (127.0.0.1) — dışa açma opsiyonel (güvenlik uyarılı)</li>
            <li>Dil: Türkçe (varsayılan) · i18n EN Backlog</li>
          </ul>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Roller (Faz 12 preset)</div>
          <p className="mb-2 text-xs text-zinc-500">Tek tıkla kural+config paketi — bot seçip şablonu otomasyonlardan da ekleyebilirsin.</p>
          <div className="flex flex-wrap gap-2">
            {["Oduncu", "Madenci", "Koruma", "Toplayıcı", "Kurye"].map((r) => (
              <span key={r} className="rounded-full border border-zinc-700 bg-zinc-950 px-3 py-1 text-xs text-zinc-400">
                {r}
              </span>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-zinc-600">
            Anti-AFK / 3D viewer / Discord webhook Backlog. Kritik olaylar Log + toast ile izlenir.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
        <b className="text-zinc-200">İlkeler:</b> sistem mesajları asla oyun sohbetine yazılmaz (İ1). Dövüş RealismLayer kapatılamaz (İ2).
        Sohbet otomasyonları varsayılan yetkili listesi (İ3). Görev önceliği: hayatta kal &gt; savunma &gt; kullanıcı &gt; otomasyon.
      </div>
    </div>
  );
}

export function Automations() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
      <span className="text-4xl">⚙️</span>
      <h1 className="text-lg font-semibold text-zinc-300">Otomasyonlar</h1>
      <p className="max-w-md text-center text-sm">
        Tetikleyici → Koşul → Aksiyon kural motoru <b>Faz 11</b>'de geliyor. Yol haritası için TODO.md'ye bak.
      </p>
    </div>
  );
}

export function Settings() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
      <span className="text-4xl">🔧</span>
      <h1 className="text-lg font-semibold text-zinc-300">Ayarlar</h1>
      <p className="max-w-md text-center text-sm">
        Genel ayarlar (dil, tema, güvenlik) <b>Faz 12</b>'de geliyor. Bot bazlı ayarlar bot detay sayfasında.
      </p>
    </div>
  );
}

import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

function initialServerId(servers: { id: string }[]): string {
  if (servers.length === 0) return "__new__";
  if (servers.length === 1) return servers[0]!.id;
  return ""; // 1'den fazla → kullanıcı seçsin
}

export function AddBotModal({ onClose }: { onClose: () => void }) {
  const servers = useAppStore((s) => s.servers);
  const supportedVersions = useAppStore((s) => s.supportedVersions);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const toast = useAppStore((s) => s.toast);

  const defaultSid = useMemo(() => initialServerId(servers), [servers]);

  const [username, setUsername] = useState("CaYa_1");
  const [count, setCount] = useState(1);
  const [serverId, setServerId] = useState(defaultSid);
  const [autostart, setAutostart] = useState(false);
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);

  const isNewServer = serverId === "__new__";
  const needsServerPick = serverId === "";
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(25565);
  const [version, setVersion] = useState("auto");
  const [serverName, setServerName] = useState("");

  const canSubmit =
    Boolean(username.trim()) && !busy && !needsServerPick && (!isNewServer || Boolean(host.trim()));

  const submit = async () => {
    if (needsServerPick) {
      toast("error", "Lütfen bir sunucu seçin");
      return;
    }
    setBusy(true);
    try {
      let sid = serverId;
      if (isNewServer) {
        const profile = await api.post<{ id: string }>("/api/servers", {
          name: serverName || `${host}:${port}`,
          host,
          port,
          version
        });
        sid = profile.id;
      }
      if (count > 1) {
        await api.post("/api/bots/bulk", { template: username, count, serverId: sid, autostart, startNow });
      } else {
        await api.post("/api/bots", { username, serverId: sid, autostart, startNow });
      }
      applySnapshot(await api.get<StateSnapshot>("/api/state"));
      toast("success", count > 1 ? `${count} bot oluşturuldu` : `${username} oluşturuldu`);
      onClose();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Backdrop tıklaması KAPATMAZ — yalnızca çarpı / Vazgeç
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-bot-title"
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id="add-bot-title" className="text-lg font-semibold text-zinc-100">
            Bot Ekle
          </h2>
          <button
            type="button"
            onClick={onClose}
            title="Kapat"
            aria-label="Kapat"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Kullanıcı adı {count > 1 && "şablonu ( {n} = numara )"}</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
              placeholder={count > 1 ? "CaYa_{n}" : "CaYa_1"}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Adet (paralel bot)</span>
            <input
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Sunucu</span>
            <select
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
            >
              {servers.length !== 1 && (
                <option value="">{servers.length === 0 ? "Kayıtlı sunucu yok — yeni profil seçin" : "Seçiniz…"}</option>
              )}
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.host}:{s.port}, {s.version})
                </option>
              ))}
              <option value="__new__">+ Yeni sunucu profili…</option>
            </select>
            {needsServerPick && (
              <span className="text-[11px] text-amber-300/90">Devam etmek için bir sunucu seçin.</span>
            )}
          </label>

          {isNewServer && (
            <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Profil adı (opsiyonel)</span>
                <input
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
                  placeholder="Benim Sunucum"
                />
              </label>
              <div className="flex gap-2">
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  <span className="text-zinc-400">IP / adres</span>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
                  />
                </label>
                <label className="flex w-24 flex-col gap-1 text-sm">
                  <span className="text-zinc-400">Port</span>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || 25565)}
                    className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-400">Minecraft sürümü</span>
                <select
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
                >
                  <option value="auto">Otomatik algıla</option>
                  {supportedVersions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-zinc-600">
                  ViaVersion&apos;lı sunucularda otomatik algı yanılabilir — sorun olursa elle seç.
                </span>
              </label>
            </div>
          )}

          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-zinc-300">
              <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
              Hemen başlat
            </label>
            <label className="flex items-center gap-2 text-zinc-300">
              <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
              Panel açılınca otomatik bağlan
            </label>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            Vazgeç
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Oluşturuluyor…" : count > 1 ? `${count} Bot Oluştur` : "Oluştur"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import type { ServerProfile, StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

export function Servers() {
  const servers = useAppStore((s) => s.servers);
  const bots = useAppStore((s) => s.bots);
  const supportedVersions = useAppStore((s) => s.supportedVersions);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();

  const empty = { name: "", host: "", port: 25565, version: "auto" };
  const [form, setForm] = useState<typeof empty>(empty);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => applySnapshot(await api.get<StateSnapshot>("/api/state"));

  const submit = async () => {
    setBusy(true);
    try {
      if (editingId) await api.patch(`/api/servers/${editingId}`, form);
      else await api.post("/api/servers", form);
      await refresh();
      setForm(empty);
      setEditingId(null);
      toast("success", editingId ? t("servers.profileUpdated") : t("servers.profileAdded"));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: ServerProfile) => {
    if (!confirm(t("servers.deleteConfirm", { name: s.name }))) return;
    try {
      await api.del(`/api/servers/${s.id}`);
      await refresh();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const botCount = (id: string) => Object.values(bots).filter((b) => b.config.serverId === id).length;

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-bold text-zinc-100">{t("servers.title")}</h1>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("servers.name")}</span>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("servers.namePlaceholder")}
            className="w-44 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">IP / {t("servers.addressLabel")}</span>
          <input
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            placeholder={t("servers.hostPlaceholder")}
            className="w-52 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("servers.port")}</span>
          <input
            type="number"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 25565 })}
            className="w-24 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("servers.version")}</span>
          <select
            value={form.version}
            onChange={(e) => setForm({ ...form, version: e.target.value })}
            className="w-36 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          >
            <option value="auto">{t("servers.autoVersion")}</option>
            {supportedVersions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={submit}
          disabled={busy || !form.host.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {editingId ? t("servers.update") : t("servers.addShort")}
        </button>
        {editingId && (
          <button
            onClick={() => {
              setEditingId(null);
              setForm(empty);
            }}
            className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            {t("common.cancel")}
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
            <tr>
              <th className="px-4 py-2.5">{t("servers.name")}</th>
              <th className="px-4 py-2.5">{t("servers.addressLabel")}</th>
              <th className="px-4 py-2.5">{t("servers.version")}</th>
              <th className="px-4 py-2.5">{t("servers.botColumn")}</th>
              <th className="px-4 py-2.5 text-right">{t("servers.actionsColumn")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {servers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-600">
                  {t("servers.empty")}
                </td>
              </tr>
            )}
            {servers.map((s) => (
              <tr key={s.id} className="bg-zinc-900/40 hover:bg-zinc-900">
                <td className="px-4 py-2.5 font-medium text-zinc-200">{s.name}</td>
                <td className="mono px-4 py-2.5 text-zinc-400">
                  {s.host}:{s.port}
                </td>
                <td className="px-4 py-2.5 text-zinc-400">{s.version}</td>
                <td className="px-4 py-2.5 text-zinc-400">{botCount(s.id)}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => {
                      setEditingId(s.id);
                      setForm({ name: s.name, host: s.host, port: s.port, version: s.version });
                    }}
                    className="mr-2 text-indigo-400 hover:underline"
                  >
                    {t("common.edit")}
                  </button>
                  <button onClick={() => remove(s)} className="text-red-400 hover:underline">
                    {t("common.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import type { AuthAccount, DeviceCodePrompt, StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

function headUrl(account: AuthAccount): string | null {
  if (!account.uuid) return null;
  return `https://mc-heads.net/avatar/${account.uuid}/32`;
}

export function Accounts() {
  const accounts = useAppStore((s) => s.accounts);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const setMsaPrompt = useAppStore((s) => s.setMsaPrompt);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const refresh = async () => {
    applySnapshot(await api.get<StateSnapshot>("/api/state"));
  };

  const startLogin = async (existing?: AuthAccount) => {
    setBusy(true);
    try {
      const path = existing ? `/api/accounts/${existing.id}/login` : "/api/accounts/login";
      const body = existing ? {} : { label: label.trim() };
      const view = await api.post<DeviceCodePrompt>(path, body);
      setMsaPrompt(view);
      if (!existing) setLabel("");
      await refresh();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      await refresh();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-xl font-bold text-zinc-100">{t("accounts.title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">{t("accounts.intro")}</p>
      </div>

      <form
        className="flex flex-wrap items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && label.trim()) void startLogin();
        }}
      >
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("accounts.label")}</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={32}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
            placeholder={t("accounts.labelPlaceholder")}
          />
        </label>
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {t("accounts.add")}
        </button>
      </form>

      {accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-500">
          {t("accounts.empty")}
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {accounts.map((account) => {
            const head = headUrl(account);
            const statusKey = `accounts.status.${account.tokenStatus}`;
            return (
              <div key={account.id} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                <div className="flex items-start gap-3">
                  {head ? (
                    <img src={head} alt="" width={32} height={32} className="h-8 w-8 rounded bg-zinc-800" />
                  ) : (
                    <div className="h-8 w-8 rounded bg-zinc-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-zinc-100">{account.username || account.label}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {account.label}
                      {account.uuid ? ` · ${account.uuid}` : ""}
                    </div>
                  </div>
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">{t(statusKey)}</span>
                </div>
                {account.errorCode && (
                  <p className="mt-2 text-xs text-red-300">{t(account.errorCode)}</p>
                )}
                <p className="mt-2 text-xs text-zinc-500">
                  {account.linkedBots.length
                    ? t("accounts.linked", { names: account.linkedBots.map((bot) => bot.username).join(", ") })
                    : t("accounts.unlinked")}
                </p>
                {renameId === account.id ? (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        await api.patch(`/api/accounts/${account.id}`, { label: renameValue });
                        setRenameId(null);
                      });
                    }}
                  >
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      maxLength={32}
                      className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                    />
                    <button type="submit" className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white">
                      {t("common.save")}
                    </button>
                  </form>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
                    onClick={() => void startLogin(account)}
                  >
                    {t(account.tokenStatus === "cached" || account.username ? "accounts.signInAgain" : "accounts.signIn")}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
                    onClick={() => {
                      setRenameId(account.id);
                      setRenameValue(account.label);
                    }}
                  >
                    {t("accounts.rename")}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
                    onClick={() => void run(() => api.post(`/api/accounts/${account.id}/sign-out`).then(() => undefined))}
                  >
                    {t("accounts.signOut")}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40"
                    onClick={() => {
                      if (!confirm(t("accounts.removeConfirm", { name: account.label }))) return;
                      void run(() => api.del(`/api/accounts/${account.id}`));
                    }}
                  >
                    {t("accounts.remove")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

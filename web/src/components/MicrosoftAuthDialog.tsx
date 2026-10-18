import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";

export function MicrosoftAuthDialog() {
  const prompt = useAppStore((s) => s.msaPrompt);
  const clear = useAppStore((s) => s.clearMsaPrompt);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();
  const [left, setLeft] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!prompt) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((prompt.expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [prompt]);

  if (!prompt) return null;

  const close = async () => {
    try {
      await api.post(`/api/accounts/${prompt.accountId}/cancel`);
    } catch {
      /* dialog still closes */
    }
    clear();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt.userCode);
      setCopied(true);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const open = async () => {
    try {
      await api.post("/api/system/open-url", { url: prompt.verificationUri });
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
      window.open(prompt.verificationUri, "_blank", "noopener,noreferrer");
    }
  };

  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="msa-title"
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <h2 id="msa-title" className="text-lg font-semibold text-zinc-100">
          {t("accounts.codeTitle")}
        </h2>
        <p className="mt-2 text-sm text-zinc-400">{t("accounts.codeHelp")}</p>
        <div className="mt-4 rounded-lg border border-indigo-900/50 bg-indigo-950/30 px-4 py-3 text-center">
          <div className="font-mono text-2xl tracking-[0.3em] text-indigo-200">{prompt.userCode}</div>
          <div className={`mt-1 text-xs ${left === 0 ? "text-red-300" : "text-zinc-500"}`}>
            {left === 0 ? t("accounts.codeExpired") : t("accounts.codeExpires", { time: `${minutes}:${seconds}` })}
          </div>
        </div>
        <p className="mt-3 break-all text-xs text-zinc-500">{prompt.verificationUri}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => void close()} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
            {t("accounts.cancel")}
          </button>
          <button type="button" onClick={() => void copy()} className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-700">
            {copied ? t("accounts.copied") : t("accounts.copy")}
          </button>
          <button type="button" onClick={() => void open()} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500">
            {t("accounts.openLink")}
          </button>
        </div>
      </div>
    </div>
  );
}

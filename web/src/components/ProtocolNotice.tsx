import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";

interface VersionSyncStatus {
  online: boolean;
  installedMineflayer: string;
  installedLatestMc: string;
  mojangLatestRelease: string | null;
  npmMineflayer: string | null;
  npmAdds: string[];
  offerInstall: boolean;
  waitingOnPrismarine: boolean;
  writable: boolean;
  restartRequired: boolean;
  error?: string;
}

type NoticeKind = "restart" | "offline" | "offer" | "waiting" | "readonly";

function noticeKind(status: VersionSyncStatus): NoticeKind | null {
  if (status.restartRequired) return "restart";
  if (!status.online && status.error) return "offline";
  if (status.offerInstall) return "offer";
  if (status.waitingOnPrismarine) return "waiting";
  if (!status.writable && status.npmMineflayer && status.npmMineflayer !== status.installedMineflayer) return "readonly";
  return null;
}

function dismissKey(status: VersionSyncStatus, kind: NoticeKind): string {
  return `caya-protocol-dismiss:${kind}:${status.mojangLatestRelease ?? ""}:${status.installedLatestMc}:${status.npmMineflayer ?? ""}`;
}

/** Global protocol warning. One click installs the published mineflayer; no second confirm. */
export function ProtocolNotice() {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const [status, setStatus] = useState<VersionSyncStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const warned = useRef(false);

  useEffect(() => {
    let cancel = false;
    void api
      .get<VersionSyncStatus>("/api/versions")
      .then((v) => {
        if (!cancel) setStatus(v);
      })
      .catch(() => {
        /* offline panel: no banner */
      });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!status || warned.current) return;
    const kind = noticeKind(status);
    if (!kind || kind === "restart") return;
    try {
      if (sessionStorage.getItem(dismissKey(status, kind)) === "1") return;
    } catch {
      /* private mode */
    }
    if (status.offerInstall) {
      warned.current = true;
      toast(
        "info",
        t("servers.versionToastUpdate", {
          added: status.npmAdds.slice(0, 4).join(", ") || status.npmMineflayer || ""
        })
      );
    } else if (status.waitingOnPrismarine) {
      warned.current = true;
      toast(
        "info",
        t("servers.versionToastGap", {
          mojang: status.mojangLatestRelease ?? "?",
          mc: status.installedLatestMc
        })
      );
    }
  }, [status, t, toast]);

  if (!status) return null;
  const kind = noticeKind(status);
  if (!kind) return null;
  const key = dismissKey(status, kind);
  let hidden = dismissedKey === key;
  if (!hidden) {
    try {
      hidden = sessionStorage.getItem(key) === "1";
    } catch {
      hidden = false;
    }
  }
  if (hidden) return null;

  const added = status.npmAdds.slice(0, 6).join(", ") || "—";
  const vars = {
    mf: status.installedMineflayer,
    mc: status.installedLatestMc,
    mojang: status.mojangLatestRelease ?? "?",
    npm: status.npmMineflayer ?? "?",
    added
  };

  let text = t("servers.versionCurrent", vars);
  let tone = "border-zinc-700 bg-zinc-900 text-zinc-300";
  const detailKeys: string[] =
    kind === "restart"
      ? ["servers.versionHelpRestart1", "servers.versionHelpRestart2"]
      : kind === "offline"
        ? ["servers.versionHelpOffline1"]
        : kind === "offer"
          ? ["servers.versionHelpOffer1", "servers.versionHelpOffer2", "servers.versionHelpOffer3"]
          : kind === "waiting"
            ? ["servers.versionHelpWait1", "servers.versionHelpWait2", "servers.versionHelpWait3", "servers.versionHelpWait4"]
            : ["servers.versionHelpReadOnly1"];
  if (kind === "restart") {
    text = t("servers.versionRestart", { mf: status.npmMineflayer ?? status.installedMineflayer });
    tone = "border-emerald-800 bg-emerald-950 text-emerald-100";
  } else if (kind === "offline") {
    text = t("servers.versionOffline");
  } else if (kind === "offer") {
    text = t("servers.versionUpdate", vars);
    tone = "border-amber-700 bg-amber-950 text-amber-50";
  } else if (kind === "waiting") {
    text = t("servers.versionWaiting", vars);
    tone = "border-amber-800 bg-amber-950/80 text-amber-100";
  } else {
    text = t("servers.versionReadOnly", vars);
    tone = "border-amber-800 bg-amber-950/80 text-amber-100";
  }

  const dismiss = () => {
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      /* private mode: hide until refresh via state */
    }
    setDismissedKey(key);
    setDetailsOpen(false);
  };

  const install = async () => {
    setInstalling(true);
    try {
      const next = await api.post<VersionSyncStatus>("/api/versions/install", {});
      setStatus(next);
      toast("success", t("servers.versionRestart", { mf: next.npmMineflayer ?? next.installedMineflayer }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const mapped =
        msg === "BOTS_ONLINE"
          ? t("servers.versionStopBots")
          : msg === "NOT_WRITABLE"
            ? t("servers.versionReadOnly", { npm: status?.npmMineflayer ?? "?" })
            : msg === "NOTHING_TO_INSTALL"
              ? t("servers.versionCurrent", {
                  mf: status?.installedMineflayer ?? "?",
                  mc: status?.installedLatestMc ?? "?"
                })
              : msg || t("servers.versionInstallFailed");
      toast("error", mapped);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className={`sticky top-0 z-30 border-b px-4 py-2 text-sm ${tone}`}>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 leading-snug">{text}</p>
        {status.offerInstall && !status.restartRequired && (
          <button
            type="button"
            disabled={installing}
            onClick={() => void install()}
            className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {installing ? t("servers.versionInstalling") : t("servers.versionInstall")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
          className="shrink-0 rounded-lg border border-current/30 px-3 py-1.5 text-xs font-medium hover:bg-black/20"
        >
          {detailsOpen ? t("servers.versionLess") : t("servers.versionMore")}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-current/80 hover:bg-black/20"
          aria-label={t("servers.versionDismiss")}
        >
          {t("servers.versionDismiss")}
        </button>
      </div>
      {detailsOpen && (
        <ul className="mt-2 max-w-3xl list-disc space-y-1 pl-5 text-xs leading-relaxed opacity-90">
          {detailKeys.map((k) => (
            <li key={k}>{t(k, vars)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

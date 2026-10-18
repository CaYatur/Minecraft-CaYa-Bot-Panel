import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useAppStore } from "../stores/useAppStore";

/**
 * Shown when the live connection to the backend drops, so the panel does not
 * look up to date while it is showing stale data. Waits a moment first to
 * avoid flashing during a normal page load.
 */
export function ConnectionNotice() {
  const connected = useAppStore((s) => s.connected);
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(timer);
  }, [connected]);
  if (!show) return null;
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-red-900/60 bg-red-950/40 px-4 py-2 text-xs text-red-200">
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      {t("connection.lostBanner")}
    </div>
  );
}

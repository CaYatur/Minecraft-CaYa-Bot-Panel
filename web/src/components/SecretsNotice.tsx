import { ShieldAlert } from "lucide-react";
import { useI18n } from "../i18n/useI18n";
import { useAppStore } from "../stores/useAppStore";

/** Visible warning when tokens and passwords cannot be encrypted at rest. */
export function SecretsNotice() {
  const secrets = useAppStore((s) => s.secrets);
  const { t } = useI18n();
  if (!secrets || secrets.encrypted) return null;
  return (
    <div role="alert" className="flex items-start gap-2 border-b border-amber-800/60 bg-amber-950/40 px-4 py-2 text-xs text-amber-200">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <span className="font-semibold">{t("secrets.title")}</span> {t("secrets.body")}
        {secrets.reason ? <span className="ml-1 text-amber-400/80">({secrets.reason})</span> : null}
      </div>
    </div>
  );
}

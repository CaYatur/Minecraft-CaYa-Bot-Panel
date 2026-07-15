import { useCallback, useMemo } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  applyDocumentLang,
  detectSystemLocale,
  resolveLocale,
  saveLocalePreference,
  translate,
  type AppLocale,
  type LocalePreference,
  type TVars
} from "./index";

/** Subscribe to locale and get t() + helpers. Re-renders on language change. */
export function useI18n() {
  const preference = useAppStore((s) => s.localePreference);
  const locale = useAppStore((s) => s.locale);
  const setLocalePreferenceStore = useAppStore((s) => s.setLocalePreference);

  const t = useCallback(
    (key: string, vars?: TVars) => translate(locale, key, vars),
    [locale]
  );

  const setLocalePreference = useCallback(
    (pref: LocalePreference) => {
      setLocalePreferenceStore(pref);
      saveLocalePreference(pref);
      applyDocumentLang(resolveLocale(pref));
    },
    [setLocalePreferenceStore]
  );

  const systemLocale = useMemo(() => detectSystemLocale(), [preference]);

  return {
    t,
    locale,
    preference,
    systemLocale,
    setLocalePreference,
    /** Convenience: status.* keys */
    statusLabel: (status: string) => t(`status.${status}`, undefined)
  };
}

export type { AppLocale, LocalePreference };

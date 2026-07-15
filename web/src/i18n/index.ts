import { en } from "./dict/en";
import { tr } from "./dict/tr";
import { detectSystemLocale, resolveLocale } from "./detect";
import type { AppLocale, LocalePreference, MessageTree } from "./types";

export type { AppLocale, LocalePreference, MessageTree };
export { detectSystemLocale, resolveLocale };

const DICTS: Record<AppLocale, MessageTree> = { en, tr };

const STORAGE_KEY = "caya.localePreference";

export function loadLocalePreference(): LocalePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "tr" || raw === "auto") return raw;
  } catch {
    /* */
  }
  return "auto";
}

export function saveLocalePreference(pref: LocalePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* */
  }
}

function lookup(tree: MessageTree, path: string): string | undefined {
  const parts = path.split(".").filter(Boolean);
  let cur: string | MessageTree | undefined = tree;
  for (const p of parts) {
    if (cur == null || typeof cur === "string") return undefined;
    cur = cur[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

export type TVars = Record<string, string | number | boolean | null | undefined>;

/**
 * Translate a dotted key. Falls back: locale → en → key itself.
 * Vars: `{name}` placeholders in the string.
 */
export function translate(locale: AppLocale, key: string, vars?: TVars): string {
  let s =
    lookup(DICTS[locale], key) ??
    (locale !== "en" ? lookup(DICTS.en, key) : undefined) ??
    key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), v == null ? "" : String(v));
    }
  }
  return s;
}

export function applyDocumentLang(locale: AppLocale) {
  try {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  } catch {
    /* */
  }
}

export const LOCALE_LABEL_KEYS: Record<LocalePreference, string> = {
  auto: "language.auto",
  en: "language.en",
  tr: "language.tr"
};

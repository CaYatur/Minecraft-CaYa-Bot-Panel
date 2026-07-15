import type { AppLocale } from "./types";

/**
 * Tarayıcı / OS dilini algıla.
 * tr* → Türkçe; diğer her şey veya algılanamazsa → İngilizce.
 */
export function detectSystemLocale(): AppLocale {
  try {
    const candidates: string[] = [];
    if (typeof navigator !== "undefined") {
      if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
      if (navigator.language) candidates.push(navigator.language);
    }
    for (const raw of candidates) {
      const tag = String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/_/g, "-");
      if (!tag) continue;
      // tr, tr-TR, tr-CY …
      if (tag === "tr" || tag.startsWith("tr-")) return "tr";
    }
  } catch {
    /* private mode / SSR */
  }
  return "en";
}

export function resolveLocale(preference: "auto" | AppLocale): AppLocale {
  if (preference === "en" || preference === "tr") return preference;
  return detectSystemLocale();
}

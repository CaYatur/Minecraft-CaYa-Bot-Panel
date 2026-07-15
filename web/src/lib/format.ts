import { translate, type AppLocale } from "../i18n";

export function fmtTime(ts: number, locale: AppLocale = "en"): string {
  return new Date(ts).toLocaleTimeString(locale === "tr" ? "tr-TR" : "en-GB", { hour12: false });
}

export function fmtPos(p: { x: number; y: number; z: number }): string {
  return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
}

/** Deterministic pastel color from player name */
export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 70%)`;
}

const DIM_KEYS: Record<string, string> = {
  overworld: "dims.overworld",
  the_nether: "dims.the_nether",
  the_end: "dims.the_end"
};

export function dimensionLabel(d: string, locale: AppLocale = "en"): string {
  const key = DIM_KEYS[d];
  if (!key) return d;
  return translate(locale, key);
}

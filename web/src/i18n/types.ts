/** Desteklenen arayüz dilleri */
export type AppLocale = "en" | "tr";

/** Kullanıcı tercihi: sistem dili veya sabit dil */
export type LocalePreference = "auto" | AppLocale;

export type MessageTree = {
  [key: string]: string | MessageTree;
};

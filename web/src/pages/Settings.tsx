import { useI18n } from "../i18n/useI18n";
import type { LocalePreference } from "../i18n";
import { useAppStore } from "../stores/useAppStore";

/** Faz 12 — Ayarlar (+ dil seçimi) */
export function Settings() {
  const bots = useAppStore((s) => s.bots);
  const servers = useAppStore((s) => s.servers);
  const connected = useAppStore((s) => s.connected);
  const { t, preference, locale, systemLocale, setLocalePreference } = useI18n();
  const list = Object.values(bots);
  const onlineCount = list.filter((b) => b.status === "online").length;

  const langOptions: { value: LocalePreference; label: string; hint: string }[] = [
    { value: "auto", label: t("language.auto"), hint: t("language.autoHint") },
    { value: "en", label: t("language.en"), hint: "English" },
    { value: "tr", label: t("language.tr"), hint: "Türkçe" }
  ];

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-zinc-100">{t("settings.title")}</h1>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
          {t("settings.botsOnline", { online: onlineCount, total: list.length })}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Language */}
        <div className="rounded-xl border border-indigo-900/40 bg-indigo-950/15 p-4 lg:col-span-2">
          <div className="mb-1 text-xs font-semibold tracking-wide text-indigo-300/90 uppercase">
            🌐 {t("language.title")}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">{t("language.fallbackNote")}</p>

          <div className="mb-3 flex flex-wrap gap-2">
            {langOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                title={o.hint}
                onClick={() => setLocalePreference(o.value)}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  preference === o.value
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <ul className="space-y-1.5 text-sm text-zinc-400">
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("language.current")}</span>
              <span className="font-medium text-zinc-200">
                {locale === "tr" ? t("language.tr") : t("language.en")}
                {preference === "auto" ? ` · ${t("language.auto")}` : ""}
              </span>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("language.systemDetected")}</span>
              <span className="mono text-zinc-300">
                {systemLocale === "tr" ? t("language.tr") : t("language.en")} ({systemLocale})
              </span>
            </li>
          </ul>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("settings.system")}</div>
          <ul className="space-y-2 text-sm text-zinc-300">
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">{t("connection.apiConnected")}</span>
              <span className="flex items-center gap-1.5">
                <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
                <span className={connected ? "text-emerald-300" : "text-red-300"}>
                  {connected ? t("connection.connected") : t("connection.none")}
                </span>
              </span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">{t("settings.botCount")}</span>
              <span className="mono text-zinc-200">{list.length}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">{t("settings.serverProfiles")}</span>
              <span className="mono text-zinc-200">{servers.length}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">{t("settings.listening")}</span>
              <span className="mono text-xs text-zinc-400">{t("settings.listeningValue")}</span>
            </li>
          </ul>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("settings.roles")}</div>
          <p className="mb-3 text-xs leading-relaxed text-zinc-500">{t("settings.rolesHint")}</p>
          <div className="flex flex-wrap gap-2">
            {[
              t("settings.roleLogger"),
              t("settings.roleMiner"),
              t("settings.roleGuard"),
              t("settings.roleGatherer"),
              t("settings.roleCourier")
            ].map((r) => (
              <span
                key={r}
                className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-1.5 text-xs text-zinc-400"
              >
                {r}
              </span>
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-zinc-600">{t("settings.backlogNote")}</p>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("settings.principles")}</div>
        <ul className="space-y-1.5 text-sm text-zinc-400">
          <li>
            <span className="text-zinc-300">İ1</span> — {t("settings.p1")}
          </li>
          <li>
            <span className="text-zinc-300">İ2</span> — {t("settings.p2")}
          </li>
          <li>
            <span className="text-zinc-300">İ3</span> — {t("settings.p3")}
          </li>
          <li>
            <span className="text-zinc-300">İ6</span> — {t("settings.p6")}
          </li>
        </ul>
      </div>
    </div>
  );
}

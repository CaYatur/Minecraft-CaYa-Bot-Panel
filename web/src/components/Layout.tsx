import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { BrainCircuit, Globe, LayoutGrid, Settings2, SlidersHorizontal, UserRound, Wrench } from "lucide-react";
import { BotLogo } from "./BotLogo";
import { MicrosoftAuthDialog } from "./MicrosoftAuthDialog";
import { ProtocolNotice } from "./ProtocolNotice";
import { SecretsNotice } from "./SecretsNotice";
import { ConnectionNotice } from "./ConnectionNotice";
import { useI18n } from "../i18n/useI18n";
import { useAppStore } from "../stores/useAppStore";

export function Layout({ children }: { children: ReactNode }) {
  const connected = useAppStore((s) => s.connected);
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  const { t, locale, preference, setLocalePreference } = useI18n();

  const NAV = [
    { to: "/", label: t("nav.panel"), icon: SlidersHorizontal },
    { to: "/automations", label: t("nav.automations"), icon: Settings2 },
    { to: "/schematics", label: t("nav.schematics"), icon: LayoutGrid },
    { to: "/mcp", label: t("nav.mcp"), icon: BrainCircuit },
    { to: "/servers", label: t("nav.servers"), icon: Globe },
    { to: "/accounts", label: t("nav.accounts"), icon: UserRound },
    { to: "/settings", label: t("nav.settings"), icon: Wrench }
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-16 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60 md:w-56" aria-label={t("app.nameShort")}>
        <div className="flex items-center gap-2 px-4 py-4">
          <BotLogo className="h-7 w-7" />
          <span
            className={`inline-block h-2 w-2 rounded-full md:hidden ${connected ? "bg-emerald-500" : "bg-red-500"}`}
            role="img"
            aria-label={connected ? t("connection.connected") : t("connection.disconnected")}
          />
          <div className="hidden md:block">
            <div className="text-sm font-bold tracking-wide text-zinc-100" title={t("app.name")}>
              {t("app.nameShort")}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
              {connected ? t("connection.connected") : t("connection.disconnected")}
            </div>
          </div>
        </div>
        <nav className="mt-2 flex flex-col gap-1 px-2" aria-label={t("app.nameShort")}>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              title={n.label}
              aria-label={n.label}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive ? "bg-indigo-600/20 text-indigo-300" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                }`
              }
            >
              <n.icon className="h-4 w-4 shrink-0" aria-hidden="true" /> <span className="hidden md:inline">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-2 border-t border-zinc-800/80 px-3 py-3 md:block">
          <div className="flex items-center gap-1 px-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
            <Globe className="h-3 w-3" /> {t("language.title")}
          </div>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["auto", t("language.auto")],
                ["en", "EN"],
                ["tr", "TR"]
              ] as const
            ).map(([code, label]) => (
              <button
                key={code}
                type="button"
                title={label}
                aria-pressed={preference === code}
                onClick={() => setLocalePreference(code)}
                className={`rounded px-2 py-1 text-[10px] font-medium ${
                  preference === code
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                }`}
              >
                {label === t("language.auto") ? "AUTO" : label}
              </button>
            ))}
          </div>
          <p className="px-1 text-[10px] leading-relaxed text-zinc-600">
            {t(`language.${locale}`)}
            {preference === "auto" ? ` · ${t("language.auto")}` : ""}
          </p>
          <p className="px-1 text-[10px] leading-relaxed text-zinc-500">
            {t("app.nameShort")} v{__APP_VERSION__}
          </p>
        </div>
      </aside>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ConnectionNotice />
        <SecretsNotice />
        <ProtocolNotice />
        {children}
      </main>

      <MicrosoftAuthDialog />

      {/* toasts */}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            title={t("common.close")}
            onClick={() => dismiss(toast.id)}
            className={`pointer-events-auto rounded-lg border px-3 py-2 text-left text-sm shadow-lg backdrop-blur ${
              toast.level === "error"
                ? "border-red-800 bg-red-950/90 text-red-200"
                : toast.level === "success"
                  ? "border-emerald-800 bg-emerald-950/90 text-emerald-200"
                  : "border-zinc-700 bg-zinc-900/90 text-zinc-200"
            }`}
          >
            {toast.message}
          </button>
        ))}
      </div>
    </div>
  );
}

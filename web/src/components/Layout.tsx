import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { BrainCircuit, Globe, LayoutGrid, Settings2, SlidersHorizontal, Wrench } from "lucide-react";
import { BotLogo } from "./BotLogo";
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
    { to: "/settings", label: t("nav.settings"), icon: Wrench }
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-925 bg-zinc-900/60">
        <div className="flex items-center gap-2 px-4 py-4">
          <BotLogo className="h-7 w-7" />
          <div>
            <div className="text-sm font-bold tracking-wide text-zinc-100" title={t("app.name")}>
              {t("app.nameShort")}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
              {connected ? t("connection.connected") : t("connection.disconnected")}
            </div>
          </div>
        </div>
        <nav className="mt-2 flex flex-col gap-1 px-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive ? "bg-indigo-600/20 text-indigo-300" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                }`
              }
            >
              <n.icon className="h-4 w-4" /> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 border-t border-zinc-800/80 px-3 py-3">
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
          <p className="px-1 text-[10px] leading-relaxed text-zinc-600">
            {t("app.principleI1")}
            <br />
            {t("app.roadmap")}
          </p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">{children}</main>

      {/* toasts */}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <button
            key={toast.id}
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

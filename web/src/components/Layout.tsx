import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAppStore } from "../stores/useAppStore";

const NAV = [
  { to: "/", label: "Panel", icon: "🎛️" },
  { to: "/automations", label: "Otomasyonlar", icon: "⚙️" },
  { to: "/servers", label: "Sunucular", icon: "🌐" },
  { to: "/settings", label: "Ayarlar", icon: "🔧" }
];

export function Layout({ children }: { children: ReactNode }) {
  const connected = useAppStore((s) => s.connected);
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-925 bg-zinc-900/60">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="text-2xl">🐺</span>
          <div>
            <div className="text-sm font-bold tracking-wide text-zinc-100">CaYa Bot Panel</div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
              {connected ? "Bağlı" : "Bağlantı yok"}
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
              <span>{n.icon}</span> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-4 py-3 text-[10px] leading-relaxed text-zinc-600">
          Sistem mesajları asla oyun sohbetine yazılmaz (İ1).
          <br />
          Yol haritası: TODO.md
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">{children}</main>

      {/* toasts */}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto rounded-lg border px-3 py-2 text-left text-sm shadow-lg backdrop-blur ${
              t.level === "error"
                ? "border-red-800 bg-red-950/90 text-red-200"
                : t.level === "success"
                  ? "border-emerald-800 bg-emerald-950/90 text-emerald-200"
                  : "border-zinc-700 bg-zinc-900/90 text-zinc-200"
            }`}
          >
            {t.message}
          </button>
        ))}
      </div>
    </div>
  );
}

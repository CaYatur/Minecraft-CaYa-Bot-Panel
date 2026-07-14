import type { BotStatus } from "../lib/types";

const STYLES: Record<BotStatus, { label: string; cls: string; pulse?: boolean }> = {
  stopped: { label: "Durdu", cls: "bg-zinc-700/40 text-zinc-400 border-zinc-600" },
  connecting: { label: "Bağlanıyor", cls: "bg-amber-500/10 text-amber-300 border-amber-700", pulse: true },
  online: { label: "Çevrimiçi", cls: "bg-emerald-500/10 text-emerald-300 border-emerald-700" },
  reconnecting: { label: "Yeniden bağlanıyor", cls: "bg-amber-500/10 text-amber-300 border-amber-700", pulse: true },
  kicked: { label: "Atıldı", cls: "bg-red-500/10 text-red-300 border-red-800" },
  error: { label: "Hata", cls: "bg-red-500/10 text-red-300 border-red-800" }
};

export function StatusBadge({ status }: { status: BotStatus }) {
  const s = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${s.pulse ? "animate-pulse" : ""}`} />
      {s.label}
    </span>
  );
}

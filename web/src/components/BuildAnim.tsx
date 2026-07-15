import { useEffect, useState } from "react";
import type { BuildPlacedBlock, BuildRuntime } from "../lib/types";

/** Basit Minecraft-tarzı blok yerleştirme animasyonu + ilerleme şeridi */
export function BuildAnim({ build }: { build: BuildRuntime }) {
  const [pulse, setPulse] = useState(0);
  const last = build.lastBlock;
  const recent = build.recentBlocks ?? [];

  useEffect(() => {
    if (!last) return;
    setPulse((p) => p + 1);
  }, [last?.t, last?.name, last?.x, last?.y, last?.z]);

  const pct = build.total > 0 ? Math.min(100, Math.round(((build.placed + (build.skipped || 0)) / build.total) * 100)) : 0;
  const busy = build.phase === "building" || build.phase === "preparing" || build.phase === "cleanup";

  return (
    <div className="space-y-3">
      {/* isometric-ish stage */}
      <div className="relative overflow-hidden rounded-xl border border-zinc-800 bg-gradient-to-b from-sky-950/40 via-zinc-950 to-emerald-950/30 p-4">
        {/* dirt horizon */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-amber-950/40 to-transparent" />
        <div className="relative flex min-h-[120px] items-end justify-center gap-1 pb-2">
          {/* stack of recent blocks as MC cubes */}
          {recent.slice(-8).map((b, i) => (
            <McCube key={`${b.t}-${i}`} block={b} index={i} highlight={i === recent.slice(-8).length - 1 && pulse > 0} />
          ))}
          {!recent.length && (
            <div className="flex flex-col items-center gap-2 py-6 text-zinc-600">
              <div className="mc-cube mc-cube--ghost" />
              <span className="text-[11px]">Blok yerleşince burada canlanır</span>
            </div>
          )}
        </div>

        {/* flying block */}
        {busy && last && last.status === "placed" && (
          <div key={pulse} className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 animate-mc-place">
            <McCube block={last} index={0} highlight flying />
          </div>
        )}

        <div className="relative mt-1 flex flex-wrap items-center justify-between gap-2 text-[10px]">
          <span className="mono text-zinc-400">
            {last ? (
              <>
                <span className={statusColor(last.status)}>{last.status === "placed" ? "▼" : last.status === "skipped" ? "·" : "×"}</span>{" "}
                <b className="text-zinc-200">{last.name}</b>{" "}
                <span className="text-zinc-600">
                  @ {last.x},{last.y},{last.z}
                </span>
              </>
            ) : (
              "—"
            )}
          </span>
          <span className="mono text-zinc-500">
            {build.placed}/{build.total}
            {build.skipped ? ` · atla ${build.skipped}` : ""}
            {build.failed ? ` · hata ${build.failed}` : ""}
          </span>
        </div>
      </div>

      {/* progress bar MC-style */}
      <div>
        <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
          <span className="truncate">{build.label || "Bekleniyor"}</span>
          <span className="mono">{pct}%</span>
        </div>
        <div className="h-3 overflow-hidden rounded border border-zinc-700 bg-zinc-950 shadow-inner">
          <div
            className={`h-full bg-[length:16px_16px] transition-all duration-300 ${
              busy
                ? "animate-mc-stripe bg-emerald-600"
                : build.phase === "done"
                  ? "bg-emerald-500"
                  : build.phase === "failed"
                    ? "bg-red-600"
                    : "bg-indigo-600"
            }`}
            style={{
              width: `${busy || build.total ? pct : 0}%`,
              backgroundImage:
                busy
                  ? "linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent)"
                  : undefined
            }}
          />
        </div>
      </div>
    </div>
  );
}

function McCube({
  block,
  index,
  highlight,
  flying
}: {
  block: BuildPlacedBlock;
  index: number;
  highlight?: boolean;
  flying?: boolean;
}) {
  const hue = hashHue(block.name);
  return (
    <div
      className={`mc-cube ${highlight ? "mc-cube--pop" : ""} ${flying ? "mc-cube--fly" : ""} ${
        block.status === "failed" ? "opacity-40" : block.status === "skipped" ? "opacity-60" : ""
      }`}
      style={{
        ["--mc-hue" as string]: String(hue),
        animationDelay: flying ? "0ms" : `${index * 30}ms`
      }}
      title={`${block.name} (${block.status})`}
    >
      <span className="mc-cube__label">{shortName(block.name)}</span>
    </div>
  );
}

function shortName(n: string) {
  const s = n.replace(/_block$/, "").replace(/_/g, " ");
  return s.length > 10 ? s.slice(0, 9) + "…" : s;
}

function hashHue(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function statusColor(s: BuildPlacedBlock["status"]) {
  if (s === "placed") return "text-emerald-400";
  if (s === "failed") return "text-red-400";
  return "text-zinc-500";
}

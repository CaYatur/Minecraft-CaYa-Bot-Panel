import { useI18n } from "../i18n/useI18n";
import type { BuildPlacedBlock, BuildRuntime } from "../lib/types";

/** İnşaat ilerleme — hafif, takılmayan UI (ağır animasyon kaldırıldı) */
export function BuildAnim({ build }: { build: BuildRuntime }) {
  const { t } = useI18n();
  const last = build.lastBlock;
  const recent = build.recentBlocks ?? [];
  const processed = build.placed + (build.skipped || 0) + (build.failed || 0);
  const pct = build.total > 0 ? Math.min(100, Math.round((processed / build.total) * 100)) : 0;
  const busy =
    build.phase === "building" ||
    build.phase === "preparing" ||
    build.phase === "acquiring" ||
    build.phase === "cleanup";

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
        {/* son bloklar — sabit grid, her seferinde yeniden mount yok */}
        <div className="mb-2 flex min-h-[52px] flex-wrap items-center gap-1.5">
          {recent.slice(-10).map((b) => (
            <span
              key={`${b.t}-${b.x}-${b.y}-${b.z}-${b.status}`}
              className={`rounded px-1.5 py-0.5 text-[10px] mono ${
                b.status === "placed"
                  ? "bg-emerald-950/70 text-emerald-300"
                  : b.status === "failed"
                    ? "bg-red-950/60 text-red-300"
                    : "bg-zinc-800 text-zinc-500"
              }`}
              title={`${b.name} @ ${b.x},${b.y},${b.z}`}
            >
              {shortName(b.name)}
            </span>
          ))}
          {!recent.length && <span className="text-[11px] text-zinc-600">{t("build.noBlocksYet")}</span>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="mono text-zinc-400 min-w-0 truncate">
            {last ? (
              <>
                <span className={statusColor(last.status)}>
                  {last.status === "placed" ? "●" : last.status === "skipped" ? "○" : "×"}
                </span>{" "}
                <b className="text-zinc-200">{last.name}</b>{" "}
                <span className="text-zinc-600">
                  {last.x},{last.y},{last.z}
                </span>
              </>
            ) : (
              "—"
            )}
          </span>
          <span className="mono shrink-0 text-zinc-500">
            {processed}/{build.total || "?"}
            {build.placed ? ` ${t("build.placedCount", { n: build.placed })}` : ""}
            {build.skipped ? ` ${t("build.skippedCount", { n: build.skipped })}` : ""}
            {build.failed ? ` ${t("build.failedCount", { n: build.failed })}` : ""}
          </span>
        </div>
      </div>

      <div>
        <div className="mb-1 flex justify-between gap-2 text-[10px] text-zinc-500">
          <span className="truncate">{build.label || t("build.waiting")}</span>
          <span className="mono shrink-0">{pct}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded border border-zinc-700 bg-zinc-950">
          <div
            className={`h-full transition-[width] duration-150 ease-out ${
              busy
                ? "bg-emerald-600"
                : build.phase === "done"
                  ? "bg-emerald-500"
                  : build.phase === "failed"
                    ? "bg-red-600"
                    : "bg-indigo-600"
            }`}
            style={{ width: `${build.total > 0 ? pct : busy ? 4 : 0}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function shortName(n: string) {
  const s = n.replace(/^minecraft:/, "").replace(/_block$/, "").replace(/_/g, " ");
  return s.length > 12 ? s.slice(0, 11) + "…" : s;
}

function statusColor(s: BuildPlacedBlock["status"]) {
  if (s === "placed") return "text-emerald-400";
  if (s === "failed") return "text-red-400";
  return "text-zinc-500";
}

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { fmtTime } from "../lib/format";
import type { LogLevel } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

const LEVEL_STYLE: Record<LogLevel, { row: string; chip: string }> = {
  debug: { row: "text-zinc-500", chip: "bg-zinc-800 text-zinc-400" },
  info: { row: "text-sky-300", chip: "bg-sky-500/10 text-sky-300" },
  success: { row: "text-emerald-300", chip: "bg-emerald-500/10 text-emerald-300" },
  warn: { row: "text-amber-300", chip: "bg-amber-500/10 text-amber-300" },
  error: { row: "text-red-300", chip: "bg-red-500/10 text-red-300" }
};

const ALL_LEVELS: LogLevel[] = ["debug", "info", "success", "warn", "error"];

export function LogPanel({ botId }: { botId?: string }) {
  const { t, locale } = useI18n();
  const logs = useAppStore((s) => s.logs);
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set(["info", "success", "warn", "error"]));
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const visible = logs.filter((l) => levels.has(l.level) && (!botId || l.botId === botId || l.botId === undefined));

  useEffect(() => {
    const el = listRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const toggleLevel = (lv: LogLevel) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lv)) next.delete(lv);
      else next.add(lv);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 pb-2">
        {ALL_LEVELS.map((lv) => (
          <button
            key={lv}
            onClick={() => toggleLevel(lv)}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-opacity ${LEVEL_STYLE[lv].chip} ${
              levels.has(lv) ? "" : "opacity-30"
            }`}
          >
            {t(`logs.levels.${lv}`)}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-zinc-600">{t("logs.recordCount", { n: visible.length })}</span>
      </div>

      <div
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="mono flex-1 space-y-0.5 overflow-y-auto py-2 text-xs"
      >
        {visible.length === 0 && <div className="py-8 text-center text-zinc-600">{t("logs.empty")}</div>}
        {visible.map((l, i) => (
          <div key={i} className={`flex gap-2 rounded px-1 leading-relaxed hover:bg-zinc-900/60 ${LEVEL_STYLE[l.level].row}`}>
            <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums">{fmtTime(l.ts, locale)}</span>
            <span className={`h-fit shrink-0 rounded px-1 text-[9px] font-bold ${LEVEL_STYLE[l.level].chip}`}>
              {t(`logs.levels.${l.level}`)}
            </span>
            <span className="shrink-0 text-zinc-500">[{l.source}]</span>
            <span className="min-w-0 break-words">
              {l.message}
              {l.detail && <span className="text-zinc-500"> — {l.detail}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

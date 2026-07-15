import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../i18n/useI18n";
import { ansiToSpans } from "../lib/ansi";
import { fmtTime, nameColor } from "../lib/format";
import { useAppStore } from "../stores/useAppStore";

/** Tüm botların sohbeti — rütbe + kullanıcı adı her zaman. */
export function AllChatPanel() {
  const { t, locale } = useI18n();
  const chat = useAppStore((s) => s.chat);
  const bots = useAppStore((s) => s.bots);
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const merged = useMemo(() => {
    const all = Object.values(chat).flat();
    all.sort((a, b) => a.ts - b.ts);
    return all.slice(-300);
  }, [chat]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [merged.length]);

  return (
    <div
      ref={listRef}
      onScroll={() => {
        const el = listRef.current;
        if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      className="mono h-full space-y-0.5 overflow-y-auto py-1 text-xs"
    >
      {merged.length === 0 && <div className="py-8 text-center text-zinc-600">{t("dashboard.allChatEmpty")}</div>}
      {merged.map((e, i) => {
        const hasFullAnsi =
          Boolean(e.ansi) && Boolean(e.username) && e.ansi!.toLowerCase().includes(e.username!.toLowerCase());
        return (
          <div key={i} className="flex gap-2 rounded px-1 leading-relaxed hover:bg-zinc-900/60">
            <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums">{fmtTime(e.ts, locale)}</span>
            <span className="h-fit shrink-0 rounded bg-zinc-800 px-1 text-[9px] text-zinc-400">
              {bots[e.botId]?.config.username ?? "?"}
            </span>
            {e.kind === "server" ? (
              <span className="min-w-0 break-words text-zinc-400 italic">{e.ansi ? ansiToSpans(e.ansi) : e.text}</span>
            ) : hasFullAnsi ? (
              <span className="min-w-0 break-words">
                {e.kind === "whisper" && <span className="mr-1 text-purple-400">{t("chat.whisperTag")}</span>}
                {ansiToSpans(e.ansi!)}
                {e.self && <span className="ml-1 text-[9px] text-indigo-400">{t("chat.botTag")}</span>}
              </span>
            ) : (
              <span className="min-w-0 break-words">
                {e.kind === "whisper" && <span className="mr-1 text-purple-400">{t("chat.whisperTag")}</span>}
                {e.prefix ? <span className="text-amber-200/90">{e.prefix}</span> : null}
                <span className="font-semibold" style={{ color: e.self ? "#818cf8" : nameColor(e.username ?? "?") }}>
                  {e.username ?? "?"}
                  {e.self ? ` ${t("chat.botTag")}` : ""}
                </span>
                <span className="text-zinc-500">{e.nameSuffix ?? ": "}</span>
                <span className="text-zinc-200">{e.text}</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

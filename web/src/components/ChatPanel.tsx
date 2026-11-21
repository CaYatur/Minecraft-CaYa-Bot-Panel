import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { ansiToSpans } from "../lib/ansi";
import { api } from "../lib/api";
import { fmtTime, nameColor } from "../lib/format";
import { sendChat } from "../lib/socket";
import type { ChatEntry } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

export function ChatPanel({ botId }: { botId: string }) {
  const { t } = useI18n();
  const entries = useAppStore((s) => s.chat[botId]) ?? [];
  const queue = useAppStore((s) => s.chatQueue[botId]) ?? 0;
  const setChatHistory = useAppStore((s) => s.setChatHistory);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickBottom = useRef(true);

  useEffect(() => {
    if (entries.length === 0) {
      api
        .get<ChatEntry[]>(`/api/bots/${botId}/chat-history?limit=200`)
        .then((h) => h.length && setChatHistory(botId, h))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    sendChat(botId, text);
    setInput("");
  };

  const visible = filter
    ? entries.filter(
        (e) =>
          e.username?.toLowerCase().includes(filter.toLowerCase()) ||
          e.text.toLowerCase().includes(filter.toLowerCase()) ||
          e.prefix?.toLowerCase().includes(filter.toLowerCase()) ||
          e.fullText?.toLowerCase().includes(filter.toLowerCase())
      )
    : entries;

  const fillCommand = (line: string) => {
    setInput(line.startsWith("/") ? line : `/${line}`);
    inputRef.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 gap-3">
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("chat.filterPlaceholder")}
          className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-indigo-600"
        />
        {queue > 0 && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
            {t("chat.queuedMessages", { n: queue })}
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-600">{t("chat.messageCount", { n: entries.length })}</span>
      </div>

      <div ref={listRef} onScroll={onScroll} className="mono min-h-0 flex-1 space-y-0.5 overflow-y-auto py-2 text-[13px]">
        {visible.length === 0 && <div className="py-8 text-center text-xs text-zinc-600">{t("chat.empty")}</div>}
        {visible.map((e, i) => (
          <ChatLine key={i} e={e} onMsg={(u) => setInput(`/msg ${u} `)} />
        ))}
      </div>

      <div className="flex gap-2 border-t border-zinc-800 pt-2">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("chat.inputPlaceholder")}
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
        />
        <button
          onClick={submit}
          disabled={!input.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
    <ServerCommandList botId={botId} onPick={fillCommand} />
    </div>
  );
}

/** Sunucunun declare_commands listesi. Tıklamak yalnızca sohbet kutusunu doldurur. */
function ServerCommandList({ botId, onPick }: { botId: string; onPick: (line: string) => void }) {
  const { t } = useI18n();
  const bot = useAppStore((s) => s.bots[botId]);
  const [query, setQuery] = useState("");
  const online = bot?.status === "online";
  const offline = !bot || bot.status === "stopped" || bot.status === "kicked" || bot.status === "error";
  const received = online ? bot?.serverCommands ?? null : null;
  const needle = query.trim().toLowerCase();
  const lines = received?.lines.filter((line) => !needle || line.toLowerCase().includes(needle)) ?? [];

  return (
    <aside className="flex h-full min-h-0 w-72 shrink-0 flex-col rounded-lg border border-zinc-800 bg-zinc-950/40">
      <div className="border-b border-zinc-800 px-3 py-2">
        <div className="text-xs font-medium text-zinc-300">{t("chat.commandsTitle")}</div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("chat.commandsSearch")}
          className="mt-2 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-indigo-600"
        />
      </div>
      <div className="mono min-h-0 flex-1 overflow-y-auto py-1 text-[12px]">
        {offline && <p className="px-3 py-6 text-center text-xs text-zinc-600">{t("chat.commandsEmptyOffline")}</p>}
        {!offline && !received && <p className="px-3 py-6 text-center text-xs text-zinc-600">{t("chat.commandsEmptyWaiting")}</p>}
        {online && received && needle && lines.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-zinc-600">{t("chat.commandsEmptyFilter")}</p>
        )}
        {lines.map((line) => (
          <button
            key={line}
            type="button"
            title={t("chat.commandsFill")}
            onClick={() => onPick(line)}
            className="block w-full truncate px-3 py-1 text-left text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
          >
            /{line}
          </button>
        ))}
      </div>
      {received && (
        <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-600">
          <div>{t("chat.commandsCount", { n: received.lines.length })}</div>
          {received.truncated && <div>{t("chat.commandsTruncated")}</div>}
        </div>
      )}
    </aside>
  );
}

/** Oyuncu satırı: her zaman rütbe + isim + gövde. ANSI yalnızca tam satırsa. */
function ChatLine({ e, onMsg }: { e: ChatEntry; onMsg: (username: string) => void }) {
  const { t, locale } = useI18n();
  const hasFullAnsi =
    Boolean(e.ansi) &&
    Boolean(e.username) &&
    e.ansi!.toLowerCase().includes(e.username!.toLowerCase());

  return (
    <div className="flex gap-2 rounded px-1 leading-relaxed hover:bg-zinc-900/60">
      <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums" style={{ paddingTop: 2 }}>
        {fmtTime(e.ts, locale)}
      </span>
      {e.kind === "server" ? (
        <span className="min-w-0 break-words text-zinc-400 italic">{e.ansi ? ansiToSpans(e.ansi) : e.text}</span>
      ) : hasFullAnsi ? (
        <span className="min-w-0 break-words">
          {e.kind === "whisper" && <span className="mr-1 text-purple-400">{t("chat.whisperTag")}</span>}
          <button
            type="button"
            onClick={() => e.username && onMsg(e.username)}
            className="text-left hover:underline"
            title={e.username ? t("chat.whisperTitle", { name: e.username }) : undefined}
          >
            {ansiToSpans(e.ansi!)}
          </button>
          {e.self && <span className="ml-1 text-[10px] text-indigo-400">{t("chat.botTag")}</span>}
        </span>
      ) : (
        <span className="min-w-0 break-words">
          {e.kind === "whisper" && <span className="mr-1 text-purple-400">{t("chat.whisperTag")}</span>}
          {e.prefix ? <span className="text-amber-200/90">{e.prefix}</span> : null}
          <button
            type="button"
            onClick={() => e.username && onMsg(e.username)}
            className="font-semibold hover:underline"
            style={{ color: e.self ? "#818cf8" : nameColor(e.username ?? "?") }}
            title={e.username ? t("chat.whisperTitle", { name: e.username }) : undefined}
          >
            {e.username ?? "?"}
            {e.self ? ` ${t("chat.botTag")}` : ""}
          </button>
          <span className="text-zinc-500">{e.nameSuffix ?? ": "}</span>
          <span className="text-zinc-200">{e.text}</span>
        </span>
      )}
    </div>
  );
}

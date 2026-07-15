import { useEffect, useRef, useState } from "react";
import { ansiToSpans } from "../lib/ansi";
import { api } from "../lib/api";
import { fmtTime, nameColor } from "../lib/format";
import { sendChat } from "../lib/socket";
import type { ChatEntry } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

export function ChatPanel({ botId }: { botId: string }) {
  const entries = useAppStore((s) => s.chat[botId]) ?? [];
  const queue = useAppStore((s) => s.chatQueue[botId]) ?? 0;
  const setChatHistory = useAppStore((s) => s.setChatHistory);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Ara / oyuncu / rütbe filtrele…"
          className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 outline-none focus:border-indigo-600"
        />
        {queue > 0 && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
            sırada {queue} mesaj (hız sınırı)
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-600">{entries.length} mesaj</span>
      </div>

      <div ref={listRef} onScroll={onScroll} className="mono flex-1 space-y-0.5 overflow-y-auto py-2 text-[13px]">
        {visible.length === 0 && <div className="py-8 text-center text-xs text-zinc-600">Henüz mesaj yok</div>}
        {visible.map((e, i) => (
          <ChatLine key={i} e={e} onMsg={(u) => setInput(`/msg ${u} `)} />
        ))}
      </div>

      <div className="flex gap-2 border-t border-zinc-800 pt-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Sohbete yaz ( / ile komut )…"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
        />
        <button
          onClick={submit}
          disabled={!input.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          Gönder
        </button>
      </div>
    </div>
  );
}

function ChatLine({ e, onMsg }: { e: ChatEntry; onMsg: (username: string) => void }) {
  return (
    <div className="flex gap-2 rounded px-1 leading-relaxed hover:bg-zinc-900/60">
      <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums" style={{ paddingTop: 2 }}>
        {fmtTime(e.ts)}
      </span>
      {e.kind === "server" ? (
        <span className="min-w-0 break-words text-zinc-400 italic">{e.ansi ? ansiToSpans(e.ansi) : e.text}</span>
      ) : e.ansi ? (
        // tam renkli satır (rütbe + isim + mesaj) — oyundaki gibi
        <span className="min-w-0 break-words">
          {e.kind === "whisper" && <span className="mr-1 text-purple-400">[fısıltı]</span>}
          <button
            type="button"
            onClick={() => e.username && onMsg(e.username)}
            className="text-left hover:underline"
            title={e.username ? `${e.username} adlı oyuncuya fısılda` : undefined}
          >
            {ansiToSpans(e.ansi)}
          </button>
          {e.self && <span className="ml-1 text-[10px] text-indigo-400">(bot)</span>}
        </span>
      ) : (
        <span className="min-w-0 break-words">
          {e.kind === "whisper" && <span className="mr-1 text-purple-400">[fısıltı]</span>}
          {e.prefix ? <span className="text-amber-200/90">{e.prefix}</span> : null}
          <button
            type="button"
            onClick={() => e.username && onMsg(e.username)}
            className="mr-0.5 font-semibold hover:underline"
            style={{ color: e.self ? "#818cf8" : nameColor(e.username ?? "?") }}
            title={e.username ? `${e.username} adlı oyuncuya fısılda` : undefined}
          >
            {e.username}
            {e.self ? " (bot)" : ""}
          </button>
          <span className="text-zinc-500">{e.nameSuffix ?? ": "}</span>
          <span className="text-zinc-200">{e.text}</span>
        </span>
      )}
    </div>
  );
}

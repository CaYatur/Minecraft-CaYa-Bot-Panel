import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  BrainCircuit,
  Check,
  Copy,
  Hammer,
  MessageSquare,
  Plug,
  RefreshCw,
  Send,
  Shield,
  Square,
  Trash2,
  Wrench,
  X,
  Zap
} from "lucide-react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { EV } from "../lib/events";
import { socket } from "../lib/socket";
import type {
  McpActivity,
  McpSettings,
  McpStatusPayload,
  McpToolPermissions,
  McpTranscriptMsg,
  OllamaModelInfo
} from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Faz 18 — MCP / AI sekmesi: Ollama oyun içi ajan + Claude Code MCP endpoint + ajan sohbeti */
export function Mcp() {
  const status = useAppStore((s) => s.mcpStatus);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();

  const patch = useCallback(
    (p: DeepPartial<McpSettings>) => {
      api.patch("/api/mcp/settings", p).catch((err) => toast("error", t("mcp.saveError", { msg: err.message })));
    },
    [toast, t]
  );

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">{t("common.loading")}</div>
    );
  }
  const s = status.settings;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      {/* header + master switch */}
      <div className="flex flex-wrap items-center gap-3">
        <BrainCircuit className="h-6 w-6 text-indigo-400" />
        <h1 className="text-xl font-bold text-zinc-100">{t("mcp.title")}</h1>
        <span className="text-xs text-zinc-500">{t("mcp.subtitle")}</span>
        <div className="ml-auto">
          <Switch checked={s.enabled} onChange={(v) => patch({ enabled: v })} label={t("mcp.masterEnable")} big />
        </div>
      </div>

      {!s.enabled && (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4 text-sm text-amber-200/90">
          <div className="mb-2 font-medium">{t("mcp.disabledBanner")}</div>
          <ul className="space-y-1 text-xs text-amber-200/70">
            <li>{t("mcp.step1")}</li>
            <li>{t("mcp.step2")}</li>
            <li>{t("mcp.step3")}</li>
            <li>{t("mcp.step4")}</li>
          </ul>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <OllamaCard status={status} patch={patch} />
        <EndpointCard status={status} patch={patch} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChatCard s={s} patch={patch} />
        <TrustCard s={s} patch={patch} />
      </div>

      <UtilityCard s={s} patch={patch} />
      <ToolsCard status={status} patch={patch} />
      <BotsCard status={status} />
      <ConsoleCard status={status} />
    </div>
  );
}

// ---- shared little controls -----------------------------------------------------------

function Switch({
  checked,
  onChange,
  label,
  big,
  disabled
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  big?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
        big ? "text-sm font-medium" : "text-xs"
      } ${disabled ? "cursor-not-allowed opacity-40" : "hover:bg-zinc-800/60"}`}
    >
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-indigo-600" : "bg-zinc-700"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </span>
      {label && <span className={checked ? "text-zinc-200" : "text-zinc-400"}>{label}</span>}
    </button>
  );
}

function Card({
  icon,
  title,
  children,
  tone = "zinc"
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  tone?: "zinc" | "indigo" | "emerald";
}) {
  const border =
    tone === "indigo"
      ? "border-indigo-900/40 bg-indigo-950/15"
      : tone === "emerald"
        ? "border-emerald-900/40 bg-emerald-950/10"
        : "border-zinc-800 bg-zinc-900/50";
  return (
    <div className={`rounded-xl border p-4 ${border}`}>
      <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
        {icon} {title}
      </div>
      {children}
    </div>
  );
}

function NumField({
  label,
  value,
  onCommit,
  min,
  max,
  step
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
      <span>{label}</span>
      <input
        type="number"
        value={v}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isFinite(n) && n !== value) onCommit(n);
        }}
        className="w-24 rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-right text-xs text-zinc-200 outline-none focus:border-indigo-600"
      />
    </label>
  );
}

function CopyLine({ value, copyLabel, copiedLabel }: { value: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="mono flex-1 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/70 px-2.5 py-1.5 text-[11px] whitespace-nowrap text-emerald-300/90">
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="flex shrink-0 items-center gap-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}

// ---- Ollama -----------------------------------------------------------------------------

function OllamaCard({ status, patch }: { status: McpStatusPayload; patch: (p: DeepPartial<McpSettings>) => void }) {
  const { t } = useI18n();
  const s = status.settings;
  const [models, setModels] = useState<OllamaModelInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [host, setHost] = useState(s.ollama.host);
  useEffect(() => setHost(s.ollama.host), [s.ollama.host]);

  const refreshModels = useCallback(() => {
    setLoading(true);
    api
      .get<{ models: OllamaModelInfo[] }>(`/api/mcp/ollama/models`)
      .then((r) => setModels(r.models))
      .catch((err) => {
        setModels([]);
        setTestMsg({ ok: false, text: err.message });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (s.enabled && s.ollama.enabled) refreshModels();
  }, [s.enabled, s.ollama.enabled, s.ollama.host, refreshModels]);

  const modelMissing =
    s.ollama.model && models !== null && models.length > 0 && !models.some((m) => m.name === s.ollama.model);

  return (
    <Card icon={<Bot className="h-3.5 w-3.5" />} title={t("mcp.ollamaTitle")} tone="indigo">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Switch checked={s.ollama.enabled} onChange={(v) => patch({ ollama: { enabled: v } })} label={t("mcp.ollamaEnable")} />
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">{t("mcp.ollamaHint")}</p>

        <label className="block text-xs text-zinc-400">
          {t("mcp.ollamaHost")}
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onBlur={() => host.trim() && host !== s.ollama.host && patch({ ollama: { host: host.trim() } })}
            placeholder="http://127.0.0.1:11434"
            className="mono mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-600"
          />
        </label>

        <div className="flex items-end gap-2">
          <label className="flex-1 text-xs text-zinc-400">
            {t("mcp.ollamaModel")}
            <select
              value={s.ollama.model}
              onChange={(e) => patch({ ollama: { model: e.target.value } })}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-600"
            >
              <option value="">{t("mcp.ollamaModelPlaceholder")}</option>
              {s.ollama.model && !models?.some((m) => m.name === s.ollama.model) && (
                <option value={s.ollama.model}>{s.ollama.model}</option>
              )}
              {(models ?? []).map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.parameterSize ? ` (${m.parameterSize})` : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={refreshModels}
            className="flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> {t("mcp.ollamaRefresh")}
          </button>
          <button
            type="button"
            onClick={() => {
              setTestMsg(null);
              api
                .post<{ version: string; models: number }>(`/api/mcp/ollama/test`)
                .then((r) => setTestMsg({ ok: true, text: t("mcp.ollamaTestOk", { version: r.version, models: r.models }) }))
                .catch((err) => setTestMsg({ ok: false, text: err.message }));
            }}
            className="rounded-lg bg-indigo-600/80 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
          >
            {t("mcp.ollamaTest")}
          </button>
        </div>

        {models !== null && models.length === 0 && <p className="text-[11px] text-amber-400/90">{t("mcp.ollamaNoModels")}</p>}
        {modelMissing && <p className="text-[11px] text-amber-400/90">{t("mcp.ollamaModelMissing")}</p>}
        {testMsg && (
          <p className={`text-[11px] ${testMsg.ok ? "text-emerald-400/90" : "text-red-400/90"}`}>{testMsg.text}</p>
        )}
        <p className="text-[11px] text-zinc-600">{t("mcp.toolSupportNote")}</p>

        <div className="grid grid-cols-2 gap-3 border-t border-zinc-800/70 pt-3">
          <NumField label={t("mcp.ollamaTemp")} value={s.ollama.temperature} min={0} max={2} step={0.1} onCommit={(v) => patch({ ollama: { temperature: v } })} />
          <NumField label={t("mcp.ollamaCtx")} value={s.ollama.numCtx} min={1024} max={131072} step={1024} onCommit={(v) => patch({ ollama: { numCtx: v } })} />
        </div>
      </div>
    </Card>
  );
}

// ---- MCP endpoint --------------------------------------------------------------------------

function EndpointCard({ status, patch }: { status: McpStatusPayload; patch: (p: DeepPartial<McpSettings>) => void }) {
  const { t } = useI18n();
  const toast = useAppStore((st) => st.toast);
  const s = status.settings;
  return (
    <Card icon={<Plug className="h-3.5 w-3.5" />} title={t("mcp.endpointTitle")} tone="emerald">
      <div className="space-y-3">
        <Switch checked={s.mcpServer.enabled} onChange={(v) => patch({ mcpServer: { enabled: v } })} label={t("mcp.endpointEnable")} />
        <p className="text-[11px] leading-relaxed text-zinc-500">{t("mcp.endpointHint")}</p>

        <div>
          <div className="mb-1 text-[11px] text-zinc-500">{t("mcp.endpointUrl")}</div>
          <CopyLine value={status.endpoint} copyLabel={t("mcp.copy")} copiedLabel={t("mcp.copied")} />
        </div>
        <div>
          <div className="mb-1 text-[11px] text-zinc-500">{t("mcp.claudeCmd")}</div>
          <CopyLine value={status.claudeCommand} copyLabel={t("mcp.copy")} copiedLabel={t("mcp.copied")} />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/70 pt-3">
          <Switch
            checked={s.mcpServer.requireToken}
            onChange={(v) => patch({ mcpServer: { requireToken: v } })}
            label={t("mcp.requireToken")}
          />
          {s.mcpServer.requireToken && (
            <button
              type="button"
              onClick={() =>
                api
                  .post(`/api/mcp/token/regenerate`)
                  .then(() => toast("success", t("toast.saved")))
                  .catch((err) => toast("error", err.message))
              }
              className="flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700"
            >
              <RefreshCw className="h-3 w-3" /> {t("mcp.regenToken")}
            </button>
          )}
        </div>
        {s.mcpServer.requireToken && (
          <CopyLine value={`Authorization: Bearer ${s.mcpServer.token}`} copyLabel={t("mcp.copy")} copiedLabel={t("mcp.copied")} />
        )}
        <p className="text-[11px] text-zinc-600">{t("mcp.tokenHint")}</p>
      </div>
    </Card>
  );
}

// ---- chat behavior ---------------------------------------------------------------------------

function ChatCard({ s, patch }: { s: McpSettings; patch: (p: DeepPartial<McpSettings>) => void }) {
  const { t } = useI18n();
  const [persona, setPersona] = useState(s.chat.personality);
  useEffect(() => setPersona(s.chat.personality), [s.chat.personality]);
  return (
    <Card icon={<MessageSquare className="h-3.5 w-3.5" />} title={t("mcp.chatTitle")}>
      <div className="space-y-2.5">
        <Switch checked={s.chat.respondInGame} onChange={(v) => patch({ chat: { respondInGame: v } })} label={t("mcp.respondInGame")} />
        <p className="pl-1 text-[11px] leading-relaxed text-zinc-500">{t("mcp.respondInGameHint")}</p>
        <Switch
          checked={s.chat.onlyWhenAddressed}
          onChange={(v) => patch({ chat: { onlyWhenAddressed: v } })}
          label={t("mcp.onlyWhenAddressed")}
          disabled={!s.chat.respondInGame}
        />
        <p className="pl-1 text-[11px] text-zinc-600">{t("mcp.onlyWhenAddressedHint")}</p>
        <Switch
          checked={s.chat.respondToWhisper}
          onChange={(v) => patch({ chat: { respondToWhisper: v } })}
          label={t("mcp.respondToWhisper")}
          disabled={!s.chat.respondInGame}
        />
        <div className="grid grid-cols-2 gap-3 pt-1">
          <NumField label={t("mcp.cooldown")} value={s.chat.perPlayerCooldownSec} min={0} max={300} onCommit={(v) => patch({ chat: { perPlayerCooldownSec: v } })} />
          <NumField label={t("mcp.maxReply")} value={s.chat.maxReplyChars} min={40} max={256} onCommit={(v) => patch({ chat: { maxReplyChars: v } })} />
        </div>
        <label className="block pt-1 text-xs text-zinc-400">
          {t("mcp.language")}
          <select
            value={s.chat.language}
            onChange={(e) => patch({ chat: { language: e.target.value as McpSettings["chat"]["language"] } })}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-600"
          >
            <option value="auto">{t("mcp.langAuto")}</option>
            <option value="tr">{t("mcp.langTr")}</option>
            <option value="en">{t("mcp.langEn")}</option>
          </select>
        </label>
        <label className="block text-xs text-zinc-400">
          {t("mcp.personality")}
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            onBlur={() => persona !== s.chat.personality && patch({ chat: { personality: persona.slice(0, 600) } })}
            placeholder={t("mcp.personalityPlaceholder")}
            rows={2}
            className="mt-1 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950/60 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-600"
          />
        </label>
      </div>
    </Card>
  );
}

// ---- trust ---------------------------------------------------------------------------------------

function TrustCard({ s, patch }: { s: McpSettings; patch: (p: DeepPartial<McpSettings>) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const add = () => {
    const clean = name.trim();
    if (!clean) return;
    if (s.trust.trustedPlayers.some((p) => p.toLowerCase() === clean.toLowerCase())) {
      setName("");
      return;
    }
    patch({ trust: { trustedPlayers: [...s.trust.trustedPlayers, clean] } as never });
    setName("");
  };
  return (
    <Card icon={<Shield className="h-3.5 w-3.5" />} title={t("mcp.trustTitle")}>
      <div className="space-y-2.5">
        <Switch checked={s.trust.enabled} onChange={(v) => patch({ trust: { enabled: v } })} label={t("mcp.trustEnable")} />
        <p className="pl-1 text-[11px] leading-relaxed text-zinc-500">{t("mcp.trustHint")}</p>

        <div className="text-xs text-zinc-400">{t("mcp.trustedPlayers")}</div>
        <div className="flex flex-wrap gap-1.5">
          {s.trust.trustedPlayers.length === 0 && <span className="text-[11px] text-zinc-600">—</span>}
          {s.trust.trustedPlayers.map((p) => (
            <span key={p} className="inline-flex items-center gap-1 rounded-full border border-emerald-900/60 bg-emerald-950/30 px-2 py-0.5 text-[11px] text-emerald-300">
              {p}
              <button
                type="button"
                onClick={() => patch({ trust: { trustedPlayers: s.trust.trustedPlayers.filter((x) => x !== p) } as never })}
                className="text-emerald-500/70 hover:text-red-400"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder={t("common.playerNamePlaceholder")}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950/60 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-600"
          />
          <button type="button" onClick={add} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700">
            {t("mcp.addPlayer")}
          </button>
        </div>

        <div className="border-t border-zinc-800/70 pt-2">
          <Switch checked={s.trust.allowModelToTrust} onChange={(v) => patch({ trust: { allowModelToTrust: v } })} label={t("mcp.allowModelTrust")} />
          <p className="pl-1 text-[11px] text-zinc-600">{t("mcp.allowModelTrustHint")}</p>
        </div>
        <label className="block text-xs text-zinc-400">
          {t("mcp.untrustedPolicy")}
          <select
            value={s.trust.untrustedPolicy}
            onChange={(e) => patch({ trust: { untrustedPolicy: e.target.value as "ignore" | "chat-only" } })}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-600"
          >
            <option value="chat-only">{t("mcp.untrustedChatOnly")}</option>
            <option value="ignore">{t("mcp.untrustedIgnore")}</option>
          </select>
        </label>
      </div>
    </Card>
  );
}

// ---- utility / "hile" modu (izinli sunucular) --------------------------------------------------------

function UtilityCard({ s, patch }: { s: McpSettings; patch: (p: DeepPartial<McpSettings>) => void }) {
  const { t } = useI18n();
  const u = s.utility;
  return (
    <div className={`rounded-xl border p-4 ${u.enabled ? "border-amber-800/60 bg-amber-950/15" : "border-zinc-800 bg-zinc-900/50"}`}>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <div className={`flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase ${u.enabled ? "text-amber-300/90" : "text-zinc-400"}`}>
          <Zap className="h-3.5 w-3.5" /> {t("mcp.utilityTitle")}
        </div>
        <Switch checked={u.enabled} onChange={(v) => patch({ utility: { enabled: v } })} label={t("mcp.utilityEnable")} />
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">{t("mcp.utilityHint")}</p>
      <div className="grid gap-1.5 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
          <Switch
            checked={u.serverCommands}
            onChange={(v) => patch({ utility: { serverCommands: v } })}
            label={t("mcp.utilityCommands")}
            disabled={!u.enabled}
          />
          <p className="pl-1 text-[10px] text-zinc-600">{t("mcp.utilityCommandsHint")}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
          <Switch
            checked={u.creativeFly}
            onChange={(v) => patch({ utility: { creativeFly: v } })}
            label={t("mcp.utilityFly")}
            disabled={!u.enabled}
          />
          <p className="pl-1 text-[10px] text-zinc-600">{t("mcp.utilityFlyHint")}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
          <Switch
            checked={u.utilityMining}
            onChange={(v) => patch({ utility: { utilityMining: v } })}
            label={t("mcp.utilityMining")}
            disabled={!u.enabled}
          />
          <p className="pl-1 text-[10px] text-zinc-600">{t("mcp.utilityMiningHint")}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-emerald-500/80">{t("mcp.utilityCombatNote")}</p>
    </div>
  );
}

// ---- tool permissions ------------------------------------------------------------------------------

const CATEGORY_ORDER: Array<keyof McpToolPermissions> = [
  "chat",
  "movement",
  "gather",
  "craft",
  "build",
  "inventory",
  "combatDefense",
  "combatAttack",
  "trust",
  "memory",
  "waypoints"
];

function ToolsCard({ status, patch }: { status: McpStatusPayload; patch: (p: DeepPartial<McpSettings>) => void }) {
  const { t } = useI18n();
  const s = status.settings;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const tool of status.tools) m.set(tool.category, (m.get(tool.category) ?? 0) + 1);
    return m;
  }, [status.tools]);
  return (
    <Card icon={<Wrench className="h-3.5 w-3.5" />} title={t("mcp.toolsTitle")}>
      <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">{t("mcp.toolsHint")}</p>
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5 opacity-70">
          <span className="text-xs text-zinc-300">{t("mcp.cat_info")}</span>
          <span className="text-[10px] text-zinc-500">
            {t("mcp.toolCount", { n: counts.get("info") ?? 0 })} · {t("common.enabled")}
          </span>
        </div>
        {CATEGORY_ORDER.map((key) => (
          <div key={key} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
            <Switch checked={s.tools[key]} onChange={(v) => patch({ tools: { [key]: v } as never })} label={t(`mcp.cat_${key}`)} />
            <span className="text-[10px] text-zinc-500">{t("mcp.toolCount", { n: counts.get(key) ?? 0 })}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-zinc-800/70 pt-3 sm:grid-cols-3 lg:w-1/2">
        <NumField label={t("mcp.apInterval")} value={s.autopilot.intervalSec} min={15} max={3600} onCommit={(v) => patch({ autopilot: { intervalSec: v } })} />
        <NumField label={t("mcp.apToolBudget")} value={s.autopilot.maxToolCallsPerRun} min={1} max={64} onCommit={(v) => patch({ autopilot: { maxToolCallsPerRun: v } })} />
        <NumField label={t("mcp.apIterations")} value={s.autopilot.maxIterationsPerRun} min={1} max={16} onCommit={(v) => patch({ autopilot: { maxIterationsPerRun: v } })} />
      </div>
    </Card>
  );
}

// ---- per-bot agents ------------------------------------------------------------------------------------

function BotsCard({ status }: { status: McpStatusPayload }) {
  const { t } = useI18n();
  const toast = useAppStore((st) => st.toast);
  const patchBot = (botId: string, p: Record<string, unknown>) =>
    api.patch(`/api/mcp/bots/${botId}`, p).catch((err) => toast("error", t("mcp.saveError", { msg: err.message })));

  return (
    <Card icon={<Bot className="h-3.5 w-3.5" />} title={t("mcp.botsTitle")}>
      <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">{t("mcp.botsHint")}</p>
      {status.bots.length === 0 && <p className="text-xs text-zinc-600">{t("mcp.noBots")}</p>}
      <div className="space-y-2">
        {status.bots.map((b) => (
          <BotAgentRow key={b.botId} bot={b} onPatch={(p) => patchBot(b.botId, p)} />
        ))}
      </div>
    </Card>
  );
}

function BotAgentRow({
  bot,
  onPatch
}: {
  bot: McpStatusPayload["bots"][number];
  onPatch: (p: Record<string, unknown>) => void;
}) {
  const { t, statusLabel } = useI18n();
  const [goal, setGoal] = useState(bot.goal);
  useEffect(() => setGoal(bot.goal), [bot.goal]);
  const online = bot.status === "online";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <div className="flex min-w-40 items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-zinc-600"}`} />
        <span className="text-sm font-medium text-zinc-200">{bot.username}</span>
        <span className="text-[10px] text-zinc-500">{statusLabel(bot.status)}</span>
        {bot.busy && (
          <span className="rounded-full bg-indigo-600/20 px-1.5 py-0.5 text-[10px] text-indigo-300">{t("mcp.busy")}…</span>
        )}
      </div>
      <Switch checked={bot.agentEnabled} onChange={(v) => onPatch({ agentEnabled: v })} label={t("mcp.agentEnabled")} />
      <Switch checked={bot.autopilot} onChange={(v) => onPatch({ autopilot: v })} label={t("mcp.autopilot")} disabled={!bot.agentEnabled} />
      <div className="flex min-w-64 flex-1 items-center gap-2">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t("mcp.goalPlaceholder")}
          disabled={!bot.agentEnabled}
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950/70 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-600 disabled:opacity-40"
        />
        {goal !== bot.goal && (
          <button
            type="button"
            onClick={() => onPatch({ goal })}
            className="rounded-lg bg-indigo-600/80 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-600"
          >
            {t("mcp.goalSave")}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- agent chat console + live activity ------------------------------------------------------------------

const EMPTY_MSGS: McpTranscriptMsg[] = [];

function ConsoleCard({ status }: { status: McpStatusPayload }) {
  const { t } = useI18n();
  const toast = useAppStore((st) => st.toast);
  const agentBots = status.bots.filter((b) => b.agentEnabled);
  const [botId, setBotId] = useState<string>("");
  const [messages, setMessages] = useState<McpTranscriptMsg[]>(EMPTY_MSGS);
  const [activity, setActivity] = useState<McpActivity[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const effectiveBotId = botId || agentBots[0]?.botId || "";

  // history yükle + canlı akış (sayfa açıkken)
  useEffect(() => {
    if (!effectiveBotId) {
      setMessages(EMPTY_MSGS);
      return;
    }
    let alive = true;
    api
      .get<{ messages: McpTranscriptMsg[] }>(`/api/mcp/agent/${effectiveBotId}/history`)
      .then((r) => alive && setMessages(r.messages))
      .catch(() => alive && setMessages(EMPTY_MSGS));

    const onChat = (p: { botId: string; msg: McpTranscriptMsg }) => {
      if (p.botId !== effectiveBotId) return;
      setMessages((cur) => (cur.some((m) => m.id === p.msg.id) ? cur : [...cur.slice(-119), p.msg]));
    };
    const onActivity = (a: McpActivity) => {
      if (a.botId !== effectiveBotId) return;
      if (a.kind === "run-end") return;
      setActivity((cur) => [...cur.slice(-59), a]);
    };
    socket.on(EV.MCP_CHAT, onChat);
    socket.on(EV.MCP_ACTIVITY, onActivity);
    return () => {
      alive = false;
      socket.off(EV.MCP_CHAT, onChat);
      socket.off(EV.MCP_ACTIVITY, onActivity);
    };
  }, [effectiveBotId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text || !effectiveBotId || sending) return;
    setInput("");
    setSending(true);
    api
      .post(`/api/mcp/agent/${effectiveBotId}/message`, { text })
      .catch((err) => toast("error", t("mcp.sendError", { msg: err.message })))
      .finally(() => setSending(false));
  };

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="rounded-xl border border-indigo-900/40 bg-indigo-950/10 p-4 xl:col-span-2">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-indigo-300/90 uppercase">
            <MessageSquare className="h-3.5 w-3.5" /> {t("mcp.consoleTitle")}
          </div>
          <span className="text-[11px] text-zinc-500">{t("mcp.consoleHint")}</span>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              {t("mcp.consoleBot")}
              <select
                value={effectiveBotId}
                onChange={(e) => setBotId(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-600"
              >
                {agentBots.length === 0 && <option value="">—</option>}
                {agentBots.map((b) => (
                  <option key={b.botId} value={b.botId}>
                    {b.username}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              title={t("mcp.consoleStop")}
              onClick={() => effectiveBotId && api.post(`/api/mcp/agent/${effectiveBotId}/stop`).catch(() => {})}
              className="rounded-lg bg-zinc-800 p-1.5 text-zinc-400 hover:bg-zinc-700 hover:text-red-300"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={t("mcp.consoleReset")}
              onClick={() => {
                if (!effectiveBotId) return;
                api
                  .post(`/api/mcp/agent/${effectiveBotId}/reset`)
                  .then(() => setMessages(EMPTY_MSGS))
                  .catch(() => {});
              }}
              className="rounded-lg bg-zinc-800 p-1.5 text-zinc-400 hover:bg-zinc-700 hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="h-80 space-y-2 overflow-y-auto rounded-lg border border-zinc-800/70 bg-zinc-950/50 p-3">
          {messages.length === 0 && <p className="text-xs text-zinc-600">{t("mcp.consoleEmpty")}</p>}
          {messages.map((m) => (
            <TranscriptRow key={m.id} m={m} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-[11px] text-indigo-300/80">
              <RefreshCw className="h-3 w-3 animate-spin" /> {t("mcp.consoleThinking")}
            </div>
          )}
        </div>

        <div className="mt-2 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={t("mcp.consolePlaceholder")}
            disabled={!effectiveBotId}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-600 disabled:opacity-40"
          />
          <button
            type="button"
            onClick={send}
            disabled={!effectiveBotId || sending || !input.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" /> {t("mcp.consoleSend")}
          </button>
        </div>
      </div>

      {/* live tool activity */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
          <Activity className="h-3.5 w-3.5" /> {t("mcp.activityTitle")}
        </div>
        <div className="h-80 space-y-1.5 overflow-y-auto">
          {activity.length === 0 && <p className="text-xs text-zinc-600">{t("mcp.activityEmpty")}</p>}
          {activity
            .slice()
            .reverse()
            .map((a, i) => (
              <div key={`${a.ts}-${i}`} className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-2 py-1.5 text-[11px]">
                <div className="flex items-center gap-1.5">
                  {a.kind === "tool-call" ? (
                    <Hammer className="h-3 w-3 text-amber-400" />
                  ) : a.kind === "error" ? (
                    <X className="h-3 w-3 text-red-400" />
                  ) : a.kind === "reply" ? (
                    <MessageSquare className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Check className="h-3 w-3 text-indigo-400" />
                  )}
                  <span className="font-medium text-zinc-300">{a.toolName ?? a.kind}</span>
                  <span className="ml-auto text-[10px] text-zinc-600">{new Date(a.ts).toLocaleTimeString()}</span>
                </div>
                {a.text && <div className="mono mt-0.5 break-all text-zinc-500">{a.text.slice(0, 220)}</div>}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function TranscriptRow({ m }: { m: McpTranscriptMsg }) {
  const { t } = useI18n();
  if (m.role === "tool") {
    return (
      <div className="ml-6 rounded-lg border border-amber-900/30 bg-amber-950/10 px-2.5 py-1.5 text-[11px]">
        <span className="mr-1.5 rounded bg-amber-600/20 px-1 py-0.5 text-[10px] font-medium text-amber-300">
          {t("mcp.roleTool")}: {m.toolName}
        </span>
        <span className={m.isError ? "text-red-300/90" : "text-zinc-400"}>{m.text.slice(0, 400)}</span>
      </div>
    );
  }
  if (m.role === "event") {
    return <div className={`px-1 text-[11px] italic ${m.isError ? "text-red-400/80" : "text-zinc-600"}`}>· {m.text}</div>;
  }
  const isUser = m.role === "user";
  const srcLabel = m.source === "game" ? t("mcp.srcGame") : m.source === "autopilot" ? t("mcp.srcAuto") : t("mcp.srcPanel");
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
          isUser ? "bg-indigo-600/25 text-indigo-100" : "bg-zinc-800/80 text-zinc-200"
        }`}
      >
        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
          {isUser ? (m.from ? `${m.from} · ${srcLabel}` : srcLabel) : "AI"}
          <span>{new Date(m.ts).toLocaleTimeString()}</span>
        </div>
        {m.text}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";

export function AlwaysOnCard({ botId }: { botId: string }) {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const [status, setStatus] = useState<{ hasPassword?: boolean; uptime?: { currentMs: number; totalMs: number; sessions: number; disconnects: number }; config?: { enabled?: boolean; antiAfk?: { enabled?: boolean }; loginPlugin?: { enabled?: boolean } } } | null>(null);
  const [password, setPassword] = useState("");

  const load = async () => {
    try {
      setStatus(await api.get(`/api/bots/${botId}/always-on`));
    } catch {
      /* bot may still be loading */
    }
  };

  useEffect(() => {
    void load();
  }, [botId]);

  const patch = async (body: unknown) => {
    try {
      await api.patch(`/api/bots/${botId}`, body);
      await load();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("ops.alwaysOn")}</div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={Boolean(status?.config?.enabled)} onChange={(e) => void patch({ alwaysOn: { enabled: e.target.checked } })} />
          {t("ops.enabled")}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={Boolean(status?.config?.antiAfk?.enabled)} onChange={(e) => void patch({ alwaysOn: { antiAfk: { enabled: e.target.checked } } })} />
          {t("ops.antiAfk")}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={Boolean(status?.config?.loginPlugin?.enabled)} onChange={(e) => void patch({ alwaysOn: { loginPlugin: { enabled: e.target.checked } } })} />
          {t("ops.loginPlugin")}
        </label>
        <button type="button" className="rounded bg-zinc-800 px-2 py-1 text-xs" onClick={() => void api.post(`/api/bots/${botId}/always-on/preset`, { preset: "sleeping_server" }).then(load)}>
          {t("ops.sleepingPreset")}
        </button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {t("ops.uptime", {
          now: Math.round((status?.uptime?.currentMs ?? 0) / 1000),
          total: Math.round((status?.uptime?.totalMs ?? 0) / 1000),
          sessions: status?.uptime?.sessions ?? 0,
          drops: status?.uptime?.disconnects ?? 0
        })}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={password}
          placeholder={status?.hasPassword ? t("ops.passwordSaved") : t("ops.password")}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
        />
        <button
          type="button"
          className="rounded bg-indigo-600 px-2 py-1 text-xs text-white"
          onClick={() => void api.put(`/api/bots/${botId}/login-plugin`, { password }).then(() => { setPassword(""); return load(); })}
        >
          {t("ops.savePassword")}
        </button>
      </div>
    </div>
  );
}

export function ViewerCard({ botId }: { botId: string }) {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const [url, setUrl] = useState<string | null>(null);
  const [scene, setScene] = useState("");

  useEffect(() => {
    if (!url) return;
    const timer = setInterval(() => void api.post(`/api/bots/${botId}/view/heartbeat`).catch(() => undefined), 5000);
    return () => {
      clearInterval(timer);
      void api.post(`/api/bots/${botId}/view/stop`).catch(() => undefined);
    };
  }, [url, botId]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("ops.viewer")}</span>
        <button
          type="button"
          className="rounded bg-zinc-800 px-2 py-1 text-xs"
          onClick={() => void api.post<{ url: string }>(`/api/bots/${botId}/view/start`).then((row) => setUrl(row.url)).catch((err) => toast("error", err instanceof Error ? err.message : String(err)))}
        >
          {t("ops.viewStart")}
        </button>
        <button
          type="button"
          className="rounded bg-zinc-800 px-2 py-1 text-xs"
          onClick={() => void api.post(`/api/bots/${botId}/view/describe`).then((row) => setScene(JSON.stringify(row).slice(0, 500))).catch((err) => toast("error", err instanceof Error ? err.message : String(err)))}
        >
          {t("ops.viewDescribe")}
        </button>
      </div>
      {url && <iframe title={t("ops.viewer")} src={url} className="h-64 w-full rounded border border-zinc-800 bg-black" />}
      {scene && <pre className="mt-2 max-h-32 overflow-auto text-[11px] text-zinc-400">{scene}</pre>}
    </div>
  );
}

export function DiscordCard() {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const [state, setState] = useState<{ hasToken?: boolean; hasWebhook?: boolean; webhookMasked?: string | null; gateway?: string; gatewayError?: string | null; bridge?: { enabled?: boolean; channelId?: string } } | null>(null);
  const [token, setToken] = useState("");
  const [webhook, setWebhook] = useState("");
  const [channelId, setChannelId] = useState("");
  const [userIds, setUserIds] = useState("");

  const load = async () => setState(await api.get("/api/discord"));
  useEffect(() => { void load().catch(() => undefined); }, []);

  const save = async () => {
    try {
      const body: Record<string, unknown> = {
        bridge: { enabled: Boolean(state?.bridge?.enabled), channelId, maxPerMinute: 20 },
        allow: { userIds: userIds.split(/[\s,]+/).filter(Boolean), roleIds: [] }
      };
      if (token.trim()) body.token = token.trim();
      if (webhook.trim()) body.webhookUrl = webhook.trim();
      await api.patch("/api/discord", body);
      setToken("");
      setWebhook("");
      toast("success", t("common.save"));
      await load();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 lg:col-span-2">
      <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("ops.discord")}</div>
      <p className="mb-3 text-xs text-zinc-500">{t("ops.discordHelp")}</p>
      <p className="mb-2 text-xs text-zinc-400">
        {t("ops.discordState", { gateway: state?.gateway ?? "off", webhook: state?.webhookMasked || (state?.hasWebhook ? t("ops.saved") : t("ops.missing")) })}
        {state?.gatewayError ? ` — ${state.gatewayError}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <input type="password" value={token} placeholder={state?.hasToken ? t("ops.tokenSaved") : t("ops.token")} onChange={(e) => setToken(e.target.value)} className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm" />
        <input type="password" value={webhook} placeholder={t("ops.webhook")} onChange={(e) => setWebhook(e.target.value)} className="min-w-56 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm" />
        <input value={channelId} placeholder={t("ops.channel")} onChange={(e) => setChannelId(e.target.value)} className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm" />
        <input value={userIds} placeholder={t("ops.allowUsers")} onChange={(e) => setUserIds(e.target.value)} className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm" />
        <button type="button" className="rounded bg-indigo-600 px-3 py-1 text-sm text-white" onClick={() => void save()}>{t("common.save")}</button>
        <button type="button" className="rounded bg-zinc-800 px-3 py-1 text-sm" onClick={() => void api.post("/api/discord/test").then(() => toast("success", t("ops.webhookOk"))).catch((err) => toast("error", err instanceof Error ? err.message : String(err)))}>{t("ops.testWebhook")}</button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import type { StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

export function AlwaysOnCard({ botId }: { botId: string }) {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const autostart = useAppStore((s) => Boolean(s.bots[botId]?.config.autostart));
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const [status, setStatus] = useState<{ uptime?: { currentMs: number; totalMs: number; sessions: number; disconnects: number }; config?: { antiAfk?: { enabled?: boolean; mode?: string } } } | null>(null);

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
      applySnapshot(await api.get<StateSnapshot>("/api/state"));
      await load();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-zinc-400">{t("ops.alwaysOnHelp")}</p>
      <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-200">
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 hover:border-indigo-400 hover:bg-zinc-700">
          <input type="checkbox" checked={autostart} onChange={(e) => void patch({ autostart: e.target.checked })} />
          {t("botDetail.autostart")}
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 hover:border-indigo-400 hover:bg-zinc-700">
          <input type="checkbox" checked={Boolean(status?.config?.antiAfk?.enabled)} onChange={(e) => void patch({ alwaysOn: { antiAfk: { enabled: e.target.checked } } })} />
          {t("ops.antiAfk")}
        </label>
        {status?.config?.antiAfk?.enabled && (
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {t("ops.antiAfkMode")}
            <select
              value={status.config.antiAfk.mode || "mixed"}
              onChange={(e) => void patch({ alwaysOn: { antiAfk: { mode: e.target.value } } })}
              className="cursor-pointer rounded-lg border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 hover:border-indigo-400"
            >
              <option value="mixed">{t("ops.antiAfkMixed")}</option>
              <option value="look">{t("ops.antiAfkLook")}</option>
              <option value="sneak">{t("ops.antiAfkSneak")}</option>
              <option value="jump">{t("ops.antiAfkJump")}</option>
              <option value="swing">{t("ops.antiAfkSwing")}</option>
              <option value="step">{t("ops.antiAfkStep")}</option>
            </select>
          </label>
        )}
      </div>
      {status?.config?.antiAfk?.enabled && <p className="text-xs text-zinc-500">{t("ops.antiAfkHelp")}</p>}
      <p className="text-xs text-zinc-500">
        {t("ops.uptime", {
          now: Math.round((status?.uptime?.currentMs ?? 0) / 1000),
          total: Math.round((status?.uptime?.totalMs ?? 0) / 1000),
          sessions: status?.uptime?.sessions ?? 0,
          drops: status?.uptime?.disconnects ?? 0
        })}
      </p>
    </div>
  );
}

export function LoginPluginCard({ botId }: { botId: string }) {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const [status, setStatus] = useState<{ hasPassword?: boolean; config?: { loginPlugin?: { enabled?: boolean; loginRepeat?: number; registerRepeat?: number; loginTemplate?: string; registerTemplate?: string } } } | null>(null);
  const [password, setPassword] = useState("");
  const [loginDraft, setLoginDraft] = useState("");
  const [registerDraft, setRegisterDraft] = useState("");

  const load = async () => {
    try {
      setStatus(await api.get(`/api/bots/${botId}/always-on`));
    } catch {
      /* bot may still be loading */
    }
  };

  useEffect(() => {
    setLoginDraft("");
    setRegisterDraft("");
    void load();
  }, [botId]);

  const patch = async (loginPlugin: { enabled?: boolean; loginRepeat?: 1 | 2; registerRepeat?: 1 | 2; loginTemplate?: string; registerTemplate?: string }) => {
    try {
      await api.patch(`/api/bots/${botId}`, { alwaysOn: { loginPlugin } });
      await load();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3">
      <div className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("ops.loginPlugin")}</div>
      <label className="flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:border-indigo-400 hover:bg-zinc-700">
        <input type="checkbox" checked={Boolean(status?.config?.loginPlugin?.enabled)} onChange={(e) => void patch({ enabled: e.target.checked })} />
        {t("ops.loginPlugin")}
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("ops.loginCommand")}
          <select
            value={loginDraft || status?.config?.loginPlugin?.loginTemplate ? "custom" : status?.config?.loginPlugin?.loginRepeat === 2 ? "2" : "1"}
            onChange={(e) => {
              if (e.target.value === "custom") {
                setLoginDraft(status?.config?.loginPlugin?.loginTemplate || "/login {password}");
                return;
              }
              setLoginDraft("");
              void patch({ loginRepeat: e.target.value === "2" ? 2 : 1, loginTemplate: "" });
            }}
            className="cursor-pointer rounded-lg border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 hover:border-indigo-400"
          >
            <option value="1">{t("ops.loginOnce")}</option>
            <option value="2">{t("ops.loginTwice")}</option>
            <option value="custom">{t("ops.loginCustom")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("ops.registerCommand")}
          <select
            value={registerDraft || status?.config?.loginPlugin?.registerTemplate ? "custom" : status?.config?.loginPlugin?.registerRepeat === 1 ? "1" : "2"}
            onChange={(e) => {
              if (e.target.value === "custom") {
                setRegisterDraft(status?.config?.loginPlugin?.registerTemplate || "/register {password} {password}");
                return;
              }
              setRegisterDraft("");
              void patch({ registerRepeat: e.target.value === "1" ? 1 : 2, registerTemplate: "" });
            }}
            className="cursor-pointer rounded-lg border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 hover:border-indigo-400"
          >
            <option value="2">{t("ops.registerTwice")}</option>
            <option value="1">{t("ops.registerOnce")}</option>
            <option value="custom">{t("ops.loginCustom")}</option>
          </select>
        </label>
      </div>
      {(loginDraft || status?.config?.loginPlugin?.loginTemplate) && (
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("ops.loginCommand")}
          <input
            value={loginDraft || status?.config?.loginPlugin?.loginTemplate || ""}
            onChange={(e) => setLoginDraft(e.target.value)}
            onBlur={() => void patch({ loginTemplate: loginDraft || status?.config?.loginPlugin?.loginTemplate || "" })}
            placeholder="/l {password}"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100"
          />
        </label>
      )}
      {(registerDraft || status?.config?.loginPlugin?.registerTemplate) && (
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("ops.registerCommand")}
          <input
            value={registerDraft || status?.config?.loginPlugin?.registerTemplate || ""}
            onChange={(e) => setRegisterDraft(e.target.value)}
            onBlur={() => void patch({ registerTemplate: registerDraft || status?.config?.loginPlugin?.registerTemplate || "" })}
            placeholder="/register {password}"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100"
          />
        </label>
      )}
      <p className="text-xs text-zinc-500">{t("ops.loginTemplateHint")}</p>
      <p className="text-xs text-zinc-500">{status?.hasPassword ? t("ops.passwordSaved") : t("ops.password")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={password}
          placeholder={t("ops.password")}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
        />
        <button
          type="button"
          className="cursor-pointer rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 active:bg-indigo-800"
          onClick={() => void api.put(`/api/bots/${botId}/login-plugin`, { password }).then(() => { setPassword(""); toast("success", t("ops.passwordSaved")); return load(); }).catch((err) => toast("error", err instanceof Error ? err.message : String(err)))}
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
  const [full, setFull] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!url) return;
    const timer = setInterval(() => void api.post(`/api/bots/${botId}/view/heartbeat`).catch(() => undefined), 5000);
    return () => {
      clearInterval(timer);
      void api.post(`/api/bots/${botId}/view/stop`).catch(() => undefined);
    };
  }, [url, botId]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-zinc-400">{t("ops.viewerHelp")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:border-indigo-400 hover:bg-zinc-700 active:bg-indigo-800"
          onClick={() => void api.post<{ url: string }>(`/api/bots/${botId}/view/start`).then((row) => setUrl(row.url)).catch((err) => toast("error", err instanceof Error ? err.message : String(err)))}
        >
          {t("ops.viewStart")}
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:border-indigo-400 hover:bg-zinc-700 active:bg-indigo-800"
          onClick={() => void api.post(`/api/bots/${botId}/view/describe`).then((row) => setScene(JSON.stringify(row).slice(0, 500))).catch((err) => toast("error", err instanceof Error ? err.message : String(err)))}
        >
          {t("ops.viewDescribe")}
        </button>
        {url && (
          <button
            type="button"
            className="cursor-pointer rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:border-indigo-400 hover:bg-zinc-700 active:bg-indigo-800"
            onClick={() => {
              const node = frameRef.current;
              if (!node) return;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void node.requestFullscreen();
            }}
          >
            {full ? t("ops.viewExit") : t("ops.viewFull")}
          </button>
        )}
      </div>
      {url && (
        <div ref={frameRef} className={full ? "flex h-full w-full flex-col bg-black" : "w-full"}>
          <iframe title={t("ops.viewer")} src={url} className={full ? "min-h-0 w-full flex-1 border-0" : "aspect-video min-h-[16rem] w-full rounded border border-zinc-800 bg-black sm:min-h-[24rem] lg:aspect-auto lg:h-[min(70vh,40rem)]"} />
        </div>
      )}
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

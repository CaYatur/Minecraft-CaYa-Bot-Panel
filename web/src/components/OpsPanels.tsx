import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import type { StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

const fieldClass = "rounded-lg border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 hover:border-indigo-400 focus:border-indigo-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export function AlwaysOnCard({ botId }: { botId: string }) {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const autostart = useAppStore((s) => Boolean(s.bots[botId]?.config.autostart));
  const delaySec = useAppStore((s) => Number(s.bots[botId]?.config.autostartDelaySec ?? 0));
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const [status, setStatus] = useState<{ uptime?: { currentMs: number; totalMs: number; sessions: number; disconnects: number }; config?: { antiAfk?: { enabled?: boolean; mode?: string; intervalMs?: number; holdMs?: number } } } | null>(null);
  const [delayDraft, setDelayDraft] = useState("0");
  const [intervalDraft, setIntervalDraft] = useState("45");
  const [holdDraft, setHoldDraft] = useState("400");

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

  useEffect(() => {
    setDelayDraft(String(delaySec));
  }, [delaySec]);

  useEffect(() => {
    const afk = status?.config?.antiAfk;
    if (!afk) return;
    setIntervalDraft(String(Math.round((afk.intervalMs ?? 45_000) / 1000)));
    setHoldDraft(String(afk.holdMs ?? 400));
  }, [status?.config?.antiAfk?.intervalMs, status?.config?.antiAfk?.holdMs]);

  const patch = async (body: unknown) => {
    try {
      await api.patch(`/api/bots/${botId}`, body);
      applySnapshot(await api.get<StateSnapshot>("/api/state"));
      await load();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    }
  };

  const antiAfkOn = Boolean(status?.config?.antiAfk?.enabled);
  const commitDelay = () => {
    const next = Math.min(300, Math.max(0, Math.round(Number(delayDraft) || 0)));
    setDelayDraft(String(next));
    if (next !== delaySec) void patch({ autostartDelaySec: next });
  };
  const commitInterval = () => {
    const sec = Math.min(600, Math.max(5, Math.round(Number(intervalDraft) || 45)));
    setIntervalDraft(String(sec));
    if (sec * 1000 !== (status?.config?.antiAfk?.intervalMs ?? 45_000)) {
      void patch({ alwaysOn: { antiAfk: { intervalMs: sec * 1000 } } });
    }
  };
  const commitHold = () => {
    const ms = Math.min(2_000, Math.max(100, Math.round(Number(holdDraft) || 400)));
    setHoldDraft(String(ms));
    if (ms !== (status?.config?.antiAfk?.holdMs ?? 400)) {
      void patch({ alwaysOn: { antiAfk: { holdMs: ms } } });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-zinc-400">{t("ops.alwaysOnHelp")}</p>
      <section className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <label className="flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:border-indigo-400 hover:bg-zinc-700">
          <input type="checkbox" checked={autostart} onChange={(e) => void patch({ autostart: e.target.checked })} />
          {t("botDetail.autostart")}
        </label>
        <p className="text-xs leading-relaxed text-zinc-500">{t("ops.autostartHelp")}</p>
        <label className="flex w-40 flex-col gap-1 text-xs text-zinc-400">
          {t("ops.autostartDelay")}
          <input
            type="number"
            min={0}
            max={300}
            value={delayDraft}
            disabled={!autostart}
            onChange={(e) => setDelayDraft(e.target.value)}
            onBlur={commitDelay}
            className={fieldClass}
          />
        </label>
        <p className="text-xs leading-relaxed text-zinc-500">{t("ops.autostartRetry")}</p>
      </section>
      <section className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <label className="flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:border-indigo-400 hover:bg-zinc-700">
          <input type="checkbox" checked={antiAfkOn} onChange={(e) => void patch({ alwaysOn: { antiAfk: { enabled: e.target.checked } } })} />
          {t("ops.antiAfk")}
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {t("ops.antiAfkMode")}
            <select
              value={status?.config?.antiAfk?.mode || "mixed"}
              disabled={!antiAfkOn}
              onChange={(e) => void patch({ alwaysOn: { antiAfk: { mode: e.target.value } } })}
              className={`cursor-pointer ${fieldClass}`}
            >
              <option value="mixed">{t("ops.antiAfkMixed")}</option>
              <option value="look">{t("ops.antiAfkLook")}</option>
              <option value="sneak">{t("ops.antiAfkSneak")}</option>
              <option value="jump">{t("ops.antiAfkJump")}</option>
              <option value="swing">{t("ops.antiAfkSwing")}</option>
              <option value="step">{t("ops.antiAfkStep")}</option>
            </select>
          </label>
          <label className="flex w-36 flex-col gap-1 text-xs text-zinc-400">
            {t("ops.antiAfkInterval")}
            <input
              type="number"
              min={5}
              max={600}
              value={intervalDraft}
              disabled={!antiAfkOn}
              onChange={(e) => setIntervalDraft(e.target.value)}
              onBlur={commitInterval}
              className={fieldClass}
            />
          </label>
          <label className="flex w-36 flex-col gap-1 text-xs text-zinc-400">
            {t("ops.antiAfkHold")}
            <input
              type="number"
              min={100}
              max={2000}
              step={50}
              value={holdDraft}
              disabled={!antiAfkOn}
              onChange={(e) => setHoldDraft(e.target.value)}
              onBlur={commitHold}
              className={fieldClass}
            />
          </label>
        </div>
        <p className="text-xs leading-relaxed text-zinc-500">{t("ops.antiAfkHelp")}</p>
      </section>
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
  const [status, setStatus] = useState<{ hasPassword?: boolean; config?: { loginPlugin?: { enabled?: boolean; loginRepeat?: number; registerRepeat?: number; loginTemplate?: string; registerTemplate?: string; sendMode?: string } } } | null>(null);
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

  const patch = async (loginPlugin: { enabled?: boolean; loginRepeat?: 1 | 2; registerRepeat?: 1 | 2; loginTemplate?: string; registerTemplate?: string; sendMode?: "prompt" | "login" | "register_first" }) => {
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
      <label className="flex w-fit flex-col gap-1 text-xs text-zinc-400">
        {t("ops.loginSendMode")}
        <select
          value={status?.config?.loginPlugin?.sendMode || "prompt"}
          onChange={(e) => void patch({ sendMode: e.target.value === "login" || e.target.value === "register_first" ? e.target.value : "prompt" })}
          className="cursor-pointer rounded-lg border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 hover:border-indigo-400"
        >
          <option value="prompt">{t("ops.loginSendPrompt")}</option>
          <option value="login">{t("ops.loginSendEach")}</option>
          <option value="register_first">{t("ops.loginSendFirst")}</option>
        </select>
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

const DISCORD_EVENTS = ["death", "disconnect", "reconnect", "mention", "whisper", "taskDone", "taskFailed", "lowHealth"] as const;
const pressable = "cursor-pointer rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 transition-colors hover:border-indigo-400 hover:bg-zinc-700 active:border-indigo-300 active:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50";
const pressablePrimary = "cursor-pointer rounded-lg border border-indigo-400 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:border-indigo-200 hover:bg-indigo-500 active:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50";

export function DiscordCard() {
  const { t } = useI18n();
  const toast = useAppStore((s) => s.toast);
  const [state, setState] = useState<{
    hasToken?: boolean;
    hasWebhook?: boolean;
    webhookMasked?: string | null;
    gateway?: string;
    gatewayError?: string | null;
    guildId?: string;
    sayAllowsCommands?: boolean;
    bridge?: { enabled?: boolean; channelId?: string };
    allow?: { userIds?: string[]; roleIds?: string[] };
    events?: Record<string, boolean>;
  } | null>(null);
  const [token, setToken] = useState("");
  const [webhook, setWebhook] = useState("");
  const [channelId, setChannelId] = useState("");
  const [userIds, setUserIds] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [guildId, setGuildId] = useState("");

  const load = async () => {
    const next = await api.get<NonNullable<typeof state>>("/api/discord");
    setState(next);
    setChannelId(next.bridge?.channelId ?? "");
    setUserIds((next.allow?.userIds ?? []).join(" "));
    setRoleIds(next.allow?.roleIds ?? []);
    setGuildId(next.guildId ?? "");
  };
  useEffect(() => { void load().catch(() => undefined); }, []);

  const patch = async (body: unknown): Promise<boolean> => {
    try {
      const next = await api.patch<NonNullable<typeof state>>("/api/discord", body);
      setState(next);
      setRoleIds(next.allow?.roleIds ?? []);
      return true;
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const saveWebhook = async () => {
    if (!webhook.trim()) return;
    const ok = await patch({ webhookUrl: webhook.trim() });
    if (!ok) return;
    setWebhook("");
    toast("success", t("common.save"));
  };

  const saveBot = async () => {
    const body: Record<string, unknown> = {
      guildId: guildId.trim(),
      sayAllowsCommands: Boolean(state?.sayAllowsCommands),
      bridge: { enabled: Boolean(state?.bridge?.enabled), channelId: channelId.trim(), maxPerMinute: 20 },
      allow: { userIds: userIds.split(/[\s,]+/).filter(Boolean), roleIds }
    };
    if (token.trim()) body.token = token.trim();
    const ok = await patch(body);
    if (!ok) return;
    setToken("");
    toast("success", t("common.save"));
  };

  const test = async () => {
    try {
      await api.post("/api/discord/test", webhook.trim() ? { url: webhook.trim() } : {});
      toast("success", t("ops.webhookOk"));
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 lg:col-span-2">
      <div>
        <div className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{t("ops.discord")}</div>
        <p className="text-xs text-zinc-400">
          {t("ops.discordState", { gateway: state?.gateway ?? "off", webhook: state?.webhookMasked || (state?.hasWebhook ? t("ops.saved") : t("ops.missing")) })}
          {state?.gatewayError ? ` — ${state.gatewayError}` : ""}
        </p>
      </div>

      <section className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="text-sm font-medium text-zinc-100">{t("ops.discordWebhookTitle")}</div>
        <p className="text-xs leading-relaxed text-zinc-400">{t("ops.discordWebhookHelp")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input type="password" value={webhook} placeholder={t("ops.webhook")} onChange={(e) => setWebhook(e.target.value)} className={`min-w-64 ${fieldClass}`} />
          <button type="button" className={pressablePrimary} disabled={!webhook.trim()} onClick={() => void saveWebhook()}>{t("ops.discordSaveWebhook")}</button>
          <button type="button" className={pressable} onClick={() => void test()}>{t("ops.testWebhook")}</button>
        </div>
        <div className="text-xs font-medium text-zinc-300">{t("ops.discordEvents")}</div>
        <div className="flex flex-wrap gap-2">
          {DISCORD_EVENTS.map((key) => (
            <label key={key} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:border-indigo-400 hover:bg-zinc-700">
              <input
                type="checkbox"
                checked={Boolean(state?.events?.[key])}
                onChange={(e) => void patch({ events: { [key]: e.target.checked } })}
              />
              {t(`ops.discordEvent.${key}`)}
            </label>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="text-sm font-medium text-zinc-100">{t("ops.discordBotTitle")}</div>
        <p className="text-xs leading-relaxed text-zinc-400">{t("ops.discordBotHelp")}</p>
        <div className="flex flex-wrap gap-2">
          <input type="password" value={token} placeholder={state?.hasToken ? t("ops.tokenSaved") : t("ops.token")} onChange={(e) => setToken(e.target.value)} className={fieldClass} />
          <input value={guildId} placeholder={t("ops.discordGuild")} onChange={(e) => setGuildId(e.target.value)} className={fieldClass} />
          <input value={userIds} placeholder={t("ops.allowUsers")} onChange={(e) => setUserIds(e.target.value)} className={`min-w-56 ${fieldClass}`} />
          <input value={channelId} placeholder={t("ops.channel")} onChange={(e) => setChannelId(e.target.value)} className={fieldClass} />
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:border-indigo-400 hover:bg-zinc-700">
            <input type="checkbox" checked={Boolean(state?.bridge?.enabled)} onChange={(e) => void patch({ bridge: { enabled: e.target.checked, channelId: channelId.trim() } })} />
            {t("ops.discordBridge")}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:border-indigo-400 hover:bg-zinc-700">
            <input type="checkbox" checked={Boolean(state?.sayAllowsCommands)} onChange={(e) => void patch({ sayAllowsCommands: e.target.checked })} />
            {t("ops.discordSayCommands")}
          </label>
          <button type="button" className={pressablePrimary} onClick={() => void saveBot()}>{t("ops.discordSaveBot")}</button>
        </div>
      </section>
    </div>
  );
}

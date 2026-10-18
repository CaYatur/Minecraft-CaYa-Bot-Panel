import { EventEmitter } from "events";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Authflow, Titles } from "prismarine-auth";
import { DATA_DIR } from "../../config/paths";
import { PanelError } from "../../core/errors";
import { newId } from "../../types";
import { createLogger } from "../../utils/logger";
import { redactSecrets } from "../../utils/redact";
import { AUTH_ERRORS, authEnglish, classifyAuthError, type AuthErrorCode } from "./messages";

const log = createLogger("auth");
const META_FILE = "accounts.json";

export interface StoredAccount {
  id: string;
  type: "microsoft";
  label: string;
  username: string | null;
  uuid: string | null;
  skinUrl: string | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  errorCode: AuthErrorCode | null;
  hasCache: boolean;
}

export interface DeviceCodeView {
  accountId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  message: string;
}

export interface PublicAccount {
  id: string;
  type: "microsoft";
  label: string;
  username: string | null;
  uuid: string | null;
  skinUrl: string | null;
  tokenStatus: "none" | "cached" | "pending" | "error";
  lastError: string | null;
  errorCode: AuthErrorCode | null;
  createdAt: number;
  linkedBots: Array<{ id: string; username: string }>;
}

interface PendingLogin {
  socketId?: string;
  botId?: string;
  view: DeviceCodeView;
  aborted: boolean;
  /** A cache already existed when this attempt started, or Microsoft has since signed in. */
  preserveCache: boolean;
}

interface BotLink {
  id: string;
  username: string;
  accountId?: string | null;
}

const FLOW_OPTIONS = {
  authTitle: Titles.MinecraftNintendoSwitch,
  deviceType: "Nintendo",
  flow: "live" as const
};

function emptyCode(accountId: string): DeviceCodeView {
  return {
    accountId,
    userCode: "",
    verificationUri: "https://www.microsoft.com/link",
    expiresAt: 0,
    message: ""
  };
}

function safeStorage(): {
  isEncryptionAvailable?: () => boolean;
  encryptString?: (s: string) => Buffer;
  decryptString?: (b: Buffer) => string;
} | null {
  try {
    // Packaged server is forked with ELECTRON_RUN_AS_NODE, so this is usually absent.
    // When the module is actually available, cache JSON is sealed at rest.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { safeStorage?: ReturnType<typeof safeStorage> };
    const api = electron.safeStorage;
    if (!api?.isEncryptionAvailable?.() || !api.encryptString || !api.decryptString) return null;
    return api;
  } catch {
    return null;
  }
}

export class AccountStore extends EventEmitter {
  private accounts: StoredAccount[] = [];
  private readonly pending = new Map<string, PendingLogin>();
  /** Account ids whose in-flight device code the user already cancelled. */
  private readonly dismissed = new Set<string>();
  private loaded = false;

  constructor(readonly rootDir: string) {
    super();
  }

  private metaPath(): string {
    return path.join(this.rootDir, META_FILE);
  }

  cacheDir(accountId: string): string {
    return path.join(this.rootDir, accountId);
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.lockDown(this.rootDir);
    try {
      if (fs.existsSync(this.metaPath())) {
        const raw = JSON.parse(fs.readFileSync(this.metaPath(), "utf8")) as StoredAccount[];
        if (Array.isArray(raw)) {
          this.accounts = raw.map((row) => ({
            id: String(row.id),
            type: "microsoft",
            label: String(row.label || "Microsoft").slice(0, 32),
            username: row.username ? String(row.username) : null,
            uuid: row.uuid ? String(row.uuid) : null,
            skinUrl: row.skinUrl ? String(row.skinUrl) : null,
            createdAt: Number(row.createdAt) || Date.now(),
            updatedAt: Number(row.updatedAt) || Date.now(),
            lastError: row.lastError ? redactSecrets(String(row.lastError)) : null,
            errorCode: row.errorCode ?? null,
            hasCache: Boolean(row.hasCache)
          }));
        }
      }
    } catch (err) {
      log.error("Could not read accounts.json, starting empty", redactSecrets(String(err)));
      this.accounts = [];
    }
    for (const row of this.accounts) row.hasCache = this.cachePresent(row.id);
    this.persist();
  }

  list(): StoredAccount[] {
    this.load();
    return this.accounts.map((row) => ({ ...row }));
  }

  get(id: string): StoredAccount | undefined {
    this.load();
    return this.accounts.find((row) => row.id === id);
  }

  /** Metadata only. Device codes stay off the broadcast snapshot. */
  publicView(links: BotLink[]): PublicAccount[] {
    this.load();
    return this.accounts.map((row) => ({
      id: row.id,
      type: "microsoft",
      label: row.label,
      username: row.username,
      uuid: row.uuid,
      skinUrl: row.skinUrl,
      tokenStatus: this.pending.has(row.id) ? "pending" : row.errorCode ? "error" : row.hasCache ? "cached" : "none",
      lastError: row.lastError,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      linkedBots: links
        .filter((bot) => bot.accountId === row.id)
        .map((bot) => ({ id: bot.id, username: bot.username }))
    }));
  }

  loginStatus(accountId: string, socketId?: string): Record<string, unknown> {
    this.load();
    const row = this.get(accountId);
    if (!row) throw new PanelError("Microsoft account not found.", 404);
    const pending = this.pending.get(accountId);
    if (!pending) {
      return {
        accountId,
        status: row.hasCache && !row.errorCode ? "success" : row.errorCode ? "error" : "none",
        errorCode: row.errorCode,
        message: row.lastError,
        username: row.username,
        uuid: row.uuid
      };
    }
    const allowed = !pending.socketId || !socketId || pending.socketId === socketId;
    return {
      accountId,
      status: "pending",
      botId: pending.botId ?? null,
      ...(allowed
        ? {
            userCode: pending.view.userCode,
            verificationUri: pending.view.verificationUri,
            expiresAt: pending.view.expiresAt,
            message: pending.view.message
          }
        : {})
    };
  }

  createRecord(label: string): StoredAccount {
    this.load();
    const name = label.trim();
    if (!name || name.length > 32) throw new PanelError("Account label must be 1-32 characters.");
    const row: StoredAccount = {
      id: newId(),
      type: "microsoft",
      label: name,
      username: null,
      uuid: null,
      skinUrl: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
      errorCode: null,
      hasCache: false
    };
    fs.mkdirSync(this.cacheDir(row.id), { recursive: true });
    this.lockDown(this.cacheDir(row.id));
    this.accounts.push(row);
    this.persist();
    this.emit("updated");
    return { ...row };
  }

  rename(id: string, label: string): StoredAccount {
    const row = this.must(id);
    const name = label.trim();
    if (!name || name.length > 32) throw new PanelError("Account label must be 1-32 characters.");
    row.label = name;
    row.updatedAt = Date.now();
    this.persist();
    this.emit("updated");
    return { ...row };
  }

  /**
   * Starts the device-code flow. Resolves when Microsoft returns the code,
   * while the token request keeps running in the background.
   */
  startLogin(label: string, socketId?: string): Promise<DeviceCodeView> {
    const row = this.createRecord(label);
    return this.beginFlow(row.id, socketId);
  }

  /** Sign in again on an existing account. Cache is kept so a refresh can succeed silently. */
  startRelogin(id: string, socketId?: string): Promise<DeviceCodeView> {
    this.must(id);
    return this.beginFlow(id, socketId);
  }

  private beginFlow(accountId: string, socketId?: string, botId?: string): Promise<DeviceCodeView> {
    this.unseal(accountId);
    const dir = this.cacheDir(accountId);
    const preserveCache = this.cachePresent(accountId);
    this.dismissed.delete(accountId);
    this.pending.set(accountId, {
      socketId,
      botId,
      aborted: false,
      preserveCache,
      view: emptyCode(accountId)
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (code: AuthErrorCode, detail?: string) => {
        if (this.dismissed.has(accountId)) return;
        const pending = this.pending.get(accountId);
        if (pending?.preserveCache || this.cachePresent(accountId)) this.clearAuthError(accountId);
        else this.fail(accountId, code, detail);
        this.pending.delete(accountId);
        this.emit("done", { socketId, accountId, ok: false, phase: "error", errorCode: code });
        this.emit("updated");
        if (!settled) {
          settled = true;
          reject(new PanelError(authEnglish(code, detail)));
        }
      };
      const timer = setTimeout(() => fail("auth.timeout"), 30_000);
      const flow = new Authflow(accountId, dir, FLOW_OPTIONS, (code) => {
        const pending = this.pending.get(accountId);
        if (!pending || pending.aborted || this.dismissed.has(accountId)) return;
        const view: DeviceCodeView = {
          accountId,
          userCode: String(code.user_code || ""),
          verificationUri: String(code.verification_uri || "https://www.microsoft.com/link"),
          expiresAt: Date.now() + Math.max(30, Number(code.expires_in) || 900) * 1000,
          message: redactSecrets(String(code.message || "Sign in with the code."))
        };
        pending.view = view;
        this.emit("code", { socketId, botId, ...view });
        this.emit("updated");
        log.info(`Device code issued for account ${accountId.slice(0, 8)}`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(view);
        }
      });
      flow
        .getMinecraftJavaToken({ fetchProfile: true })
        .then((result) => {
          clearTimeout(timer);
          const pending = this.pending.get(accountId);
          if (this.dismissed.has(accountId) || pending?.aborted) {
            this.dismissed.delete(accountId);
            if (!preserveCache) this.wipeCache(accountId);
            else this.clearAuthError(accountId);
            this.pending.delete(accountId);
            return;
          }
          this.rememberProfile(accountId, result.profile);
          this.pending.delete(accountId);
          this.seal(accountId);
          this.emit("done", { socketId, accountId, ok: true, phase: "success" });
          this.emit("updated");
          log.success(`Microsoft profile saved for account ${accountId.slice(0, 8)}`);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          if (this.dismissed.has(accountId)) {
            this.dismissed.delete(accountId);
            if (!preserveCache) this.wipeCache(accountId);
            else this.clearAuthError(accountId);
            this.pending.delete(accountId);
            return;
          }
          const code = classifyAuthError(err);
          const detail = redactSecrets(err instanceof Error ? err.message : String(err));
          const keep = preserveCache || this.cachePresent(accountId);
          this.pending.delete(accountId);
          if (keep) this.clearAuthError(accountId);
          else this.fail(accountId, code, detail);
          this.emit("done", { socketId, accountId, ok: false, phase: "error", errorCode: code });
          this.emit("updated");
          if (!settled) {
            settled = true;
            reject(new PanelError(authEnglish(code, detail)));
          }
        });
    });
  }

  /** Called from a bot connect when mineflayer itself asks for a code. */
  publishBotCode(
    accountId: string,
    code: { user_code?: string; verification_uri?: string; expires_in?: number; message?: string },
    socketId?: string,
    botId?: string
  ): DeviceCodeView {
    this.must(accountId);
    const view: DeviceCodeView = {
      accountId,
      userCode: String(code.user_code || ""),
      verificationUri: String(code.verification_uri || "https://www.microsoft.com/link"),
      expiresAt: Date.now() + Math.max(30, Number(code.expires_in) || 900) * 1000,
      message: redactSecrets(String(code.message || "Sign in with the code."))
    };
    this.pending.set(accountId, {
      socketId,
      botId,
      view,
      aborted: false,
      preserveCache: this.cachePresent(accountId)
    });
    this.emit("code", { socketId, botId, ...view });
    this.emit("updated");
    log.info(`Device code issued while connecting bot ${botId?.slice(0, 8) ?? "?"}`);
    return view;
  }

  cancel(id: string) {
    const pending = this.pending.get(id);
    if (pending) pending.aborted = true;
    const preserve = Boolean(pending?.preserveCache) || this.cachePresent(id);
    this.dismissed.add(id);
    this.pending.delete(id);
    if (preserve) this.clearAuthError(id);
    else this.fail(id, "auth.cancelled");
    this.emit("cancelled", { accountId: id, botId: pending?.botId });
    this.emit("updated");
  }

  /** Microsoft accepted the account and the bot is now joining. Keeps the dialog, hides the code. */
  markJoining(accountId: string) {
    const pending = this.pending.get(accountId);
    if (!pending) return;
    pending.preserveCache = true;
    this.emit("done", { socketId: pending.socketId, accountId, ok: true, phase: "joining" });
  }

  /**
   * Closes a device code that mineflayer opened while connecting.
   * A join failure (name already online) does not delete a saved sign-in.
   */
  finishPrompt(accountId: string, result: { ok: boolean; errorCode?: string }) {
    const pending = this.pending.get(accountId);
    if (!pending) return;
    const socketId = pending.socketId;
    const preserve = pending.preserveCache || this.cachePresent(accountId);
    this.pending.delete(accountId);
    this.dismissed.delete(accountId);
    if (result.ok) {
      this.clearAuthError(accountId);
      this.emit("done", { socketId, accountId, ok: true, phase: "success" });
      this.emit("updated");
      return;
    }
    const code = result.errorCode && result.errorCode in AUTH_ERRORS ? (result.errorCode as AuthErrorCode) : "auth.failed";
    const keepSession = preserve || code === "auth.nameTaken" || code === "auth.cancelledKept";
    if (keepSession) this.clearAuthError(accountId);
    else this.fail(accountId, code);
    this.emit("done", { socketId, accountId, ok: false, phase: "error", errorCode: code });
    this.emit("updated");
  }

  rememberProfile(
    accountId: string,
    profile: { id?: string; name?: string; skins?: Array<{ url?: string; state?: string }> } | null | undefined
  ) {
    const row = this.get(accountId);
    if (!row || !profile?.name) return;
    const skin = profile.skins?.find((item) => item.state === "ACTIVE") ?? profile.skins?.[0];
    row.username = String(profile.name);
    row.uuid = profile.id ? String(profile.id).replace(/-/g, "") : row.uuid;
    if (skin?.url) row.skinUrl = String(skin.url);
    row.lastError = null;
    row.errorCode = null;
    row.hasCache = this.cachePresent(accountId);
    row.updatedAt = Date.now();
    this.restrictCacheFiles(accountId);
    this.persist();
    this.emit("profile", { accountId, username: row.username, uuid: row.uuid });
    this.emit("updated");
  }

  noteError(accountId: string, code: AuthErrorCode) {
    this.fail(accountId, code);
  }

  signOut(id: string) {
    const row = this.must(id);
    this.pending.delete(id);
    this.wipeCache(id);
    row.hasCache = false;
    row.lastError = null;
    row.errorCode = null;
    row.updatedAt = Date.now();
    this.persist();
    this.emit("updated");
    log.info(`Signed out account ${id.slice(0, 8)}`);
  }

  remove(id: string) {
    this.must(id);
    this.pending.delete(id);
    this.wipeCache(id);
    this.accounts = this.accounts.filter((row) => row.id !== id);
    this.persist();
    this.emit("removed", { accountId: id });
    this.emit("updated");
  }

  prepareCache(accountId: string) {
    this.must(accountId);
    fs.mkdirSync(this.cacheDir(accountId), { recursive: true });
    this.lockDown(this.cacheDir(accountId));
    this.unseal(accountId);
  }

  /** Seal after the bot process is done writing tokens. No-op without Electron safeStorage. */
  seal(accountId: string) {
    const api = safeStorage();
    if (!api?.encryptString) return;
    const dir = this.cacheDir(accountId);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      const raw = fs.readFileSync(file);
      fs.writeFileSync(file + ".enc", api.encryptString(raw.toString("utf8")));
      fs.rmSync(file, { force: true });
    }
  }

  hasCache(accountId: string): boolean {
    this.unseal(accountId);
    return this.cachePresent(accountId);
  }

  cacheKey(accountId: string): string {
    this.must(accountId);
    return accountId;
  }

  private unseal(accountId: string) {
    const api = safeStorage();
    if (!api?.decryptString) return;
    const dir = this.cacheDir(accountId);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json.enc")) continue;
      const sealed = path.join(dir, name);
      const plain = sealed.slice(0, -4);
      if (fs.existsSync(plain)) continue;
      const decoded = api.decryptString(fs.readFileSync(sealed));
      fs.writeFileSync(plain, decoded, { encoding: "utf8", mode: 0o600 });
    }
  }

  private clearAuthError(accountId: string) {
    const row = this.get(accountId);
    if (!row) return;
    row.hasCache = this.cachePresent(accountId);
    if (row.hasCache) {
      row.errorCode = null;
      row.lastError = null;
    }
    row.updatedAt = Date.now();
    this.persist();
  }

  private fail(accountId: string, code: AuthErrorCode, detail?: string) {
    const row = this.get(accountId);
    if (!row) return;
    row.errorCode = code;
    row.lastError = authEnglish(code, detail);
    row.updatedAt = Date.now();
    row.hasCache = this.cachePresent(accountId);
    this.persist();
    this.emit("updated");
    log.warn(`Account ${accountId.slice(0, 8)}: ${row.lastError}`);
  }

  private must(id: string): StoredAccount {
    const row = this.get(id);
    if (!row) throw new PanelError("Microsoft account not found.", 404);
    return row;
  }

  private cachePresent(accountId: string): boolean {
    const dir = this.cacheDir(accountId);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((name) => {
      if (!/[_-](mca|live|msal|xbl)-cache\.json(\.enc)?$/.test(name)) return false;
      try {
        if (name.endsWith(".enc")) return fs.statSync(path.join(dir, name)).size > 16;
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as unknown;
        return Boolean(parsed && typeof parsed === "object" && Object.keys(parsed as object).length > 0);
      } catch {
        return false;
      }
    });
  }

  private wipeCache(accountId: string) {
    fs.rmSync(this.cacheDir(accountId), { recursive: true, force: true });
  }

  private restrictCacheFiles(accountId: string) {
    const dir = this.cacheDir(accountId);
    if (!fs.existsSync(dir)) return;
    this.lockDown(dir);
    if (process.platform === "win32") return;
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.chmodSync(path.join(dir, name), 0o600);
      } catch {
        /* best effort */
      }
    }
  }

  private lockDown(dir: string) {
    try {
      if (process.platform === "win32") {
        const user = process.env.USERNAME;
        if (!user) return;
        execFile(
          "icacls",
          [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`],
          { windowsHide: true },
          () => {
            /* user-only ACL is best effort */
          }
        );
        return;
      }
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      log.warn("Could not restrict auth cache permissions", redactSecrets(String(err)));
    }
  }

  private persist() {
    const file = this.metaPath();
    const tmp = file + ".tmp";
    const body = JSON.stringify(
      this.accounts.map((row) => ({
        id: row.id,
        type: row.type,
        label: row.label,
        username: row.username,
        uuid: row.uuid,
        skinUrl: row.skinUrl,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastError: row.lastError,
        errorCode: row.errorCode,
        hasCache: row.hasCache
      })),
      null,
      2
    );
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best effort */
      }
    }
  }
}

export const accounts = new AccountStore(path.join(DATA_DIR, "auth"));

const OPEN_HOSTS = new Set(["www.microsoft.com", "microsoft.com", "login.live.com", "login.microsoftonline.com", "login.microsoft.com"]);

export function assertMicrosoftUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PanelError("Invalid verification URL.");
  }
  if (url.protocol !== "https:" || !OPEN_HOSTS.has(url.hostname)) {
    throw new PanelError("Only Microsoft sign-in links can be opened.");
  }
  return url;
}

export function openExternalUrl(raw: string): void {
  const url = assertMicrosoftUrl(raw).toString();
  const { spawn } = require("child_process") as typeof import("child_process");
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export function authErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code in AUTH_ERRORS) return AUTH_ERRORS[code as AuthErrorCode];
  return null;
}

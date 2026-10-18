import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../utils/logger";

const log = createLogger("secrets");

/**
 * Shared encrypted-at-rest helper for every secret the panel stores
 * (Microsoft token caches, Discord token/webhook, login-plugin passwords).
 *
 * The packaged server runs with ELECTRON_RUN_AS_NODE, so it has no access to
 * the OS keychain. The Electron main process owns a random data key that it
 * protects with the OS keychain and hands to this process over the fork IPC
 * channel. Files are then sealed here with AES-256-GCM.
 *
 * Without a key (plain `npm run dev`, or the OS keychain is unavailable) the
 * panel keeps working but writes plaintext and reports a visible warning.
 */

export const SEALED_SUFFIX = ".sealed";
const MAGIC = "caya-sealed";
const VERSION = 1;

export interface SecretStatus {
  encrypted: boolean;
  /** Short machine-readable reason when encryption is off. */
  reason: string | null;
}

let key: Buffer | null = null;
let status: SecretStatus = { encrypted: false, reason: "not-initialised" };

interface KeyReply {
  type?: string;
  key?: string | null;
  reason?: string | null;
}

/**
 * Asks the Electron main process for the data key. Resolves quickly outside
 * Electron. Must finish before any secret store is read.
 */
export function initSecretBox(timeoutMs = 5000): Promise<SecretStatus> {
  if (typeof process.send !== "function" || process.env.CAYA_SECRET_IPC !== "1") {
    status = { encrypted: false, reason: "no-desktop-shell" };
    log.warn("Secrets are stored without encryption (running outside the desktop app).");
    return Promise.resolve(status);
  }
  return new Promise((resolve) => {
    const done = (next: SecretStatus) => {
      clearTimeout(timer);
      process.off("message", onMessage);
      status = next;
      if (!next.encrypted) log.warn(`Secrets are stored without encryption (${next.reason}).`);
      resolve(next);
    };
    const onMessage = (msg: unknown) => {
      const reply = msg as KeyReply;
      if (!reply || reply.type !== "caya:secret-key") return;
      if (reply.key) {
        const buf = Buffer.from(reply.key, "base64");
        if (buf.length === 32) {
          key = buf;
          done({ encrypted: true, reason: null });
          return;
        }
        done({ encrypted: false, reason: "bad-key" });
        return;
      }
      done({ encrypted: false, reason: String(reply.reason || "keychain-unavailable").slice(0, 60) });
    };
    const timer = setTimeout(() => done({ encrypted: false, reason: "key-timeout" }), timeoutMs);
    process.on("message", onMessage);
    process.send!({ type: "caya:secret-key:request" });
  });
}

/** Test hook: install a key directly (or remove it with null). */
export function setSecretKeyForTests(next: Buffer | null): void {
  key = next && next.length === 32 ? Buffer.from(next) : null;
  status = key ? { encrypted: true, reason: null } : { encrypted: false, reason: "test" };
}

export function secretStatus(): SecretStatus {
  return { ...status };
}

export function sealString(plain: string, withKey: Buffer | null = key): string {
  if (!withKey) throw new Error("No encryption key");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", withKey, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return JSON.stringify({
    magic: MAGIC,
    v: VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  });
}

export function openString(sealed: string, withKey: Buffer | null = key): string {
  if (!withKey) throw new Error("No encryption key");
  const box = JSON.parse(sealed) as { magic?: string; v?: number; iv?: string; tag?: string; data?: string };
  if (box?.magic !== MAGIC || box.v !== VERSION || !box.iv || !box.tag || typeof box.data !== "string") {
    throw new Error("Not a sealed file");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", withKey, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
}

function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
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

/** Overwrites then removes a plaintext file so the bytes are not trivially recoverable. */
export function shredFile(file: string): void {
  try {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size > 0) fs.writeFileSync(file, Buffer.alloc(size, 0));
  } catch {
    /* best effort */
  }
  fs.rmSync(file, { force: true });
}

/**
 * Writes a secret for `file` (the logical plaintext path). With a key the
 * data lands in `file.sealed` and any plaintext copy is removed.
 */
export function writeSecretFile(file: string, plain: string): void {
  if (key) {
    atomicWrite(file + SEALED_SUFFIX, sealString(plain));
    shredFile(file);
    return;
  }
  atomicWrite(file, plain);
}

/**
 * Reads a secret for `file`. Prefers the sealed copy; a leftover plaintext
 * copy is migrated (sealed, then deleted) as soon as a key is available.
 * Returns null when nothing readable exists.
 */
export function readSecretFile(file: string): string | null {
  const sealedPath = file + SEALED_SUFFIX;
  if (key && fs.existsSync(sealedPath)) {
    try {
      const plain = openString(fs.readFileSync(sealedPath, "utf8"));
      if (fs.existsSync(file)) shredFile(file);
      return plain;
    } catch (err) {
      log.error(`Could not decrypt ${path.basename(sealedPath)}`, String(err instanceof Error ? err.message : err));
      return null;
    }
  }
  if (!fs.existsSync(file)) return null;
  let plain: string;
  try {
    plain = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (key) {
    try {
      writeSecretFile(file, plain);
      log.info(`Encrypted existing ${path.basename(file)}`);
    } catch (err) {
      log.error(`Could not encrypt ${path.basename(file)}`, String(err));
    }
  }
  return plain;
}

export function deleteSecretFile(file: string): void {
  shredFile(file);
  fs.rmSync(file + SEALED_SUFFIX, { force: true });
}

export function readSecretJson<T>(file: string, fallback: T): T {
  const raw = readSecretFile(file);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeSecretJson(file: string, data: unknown): void {
  writeSecretFile(file, JSON.stringify(data));
}

/** Seals every plaintext secret file under `dir` matching `pattern` (startup migration). */
export function migratePlaintextIn(dir: string, pattern: RegExp): number {
  if (!key || !fs.existsSync(dir)) return 0;
  let moved = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!pattern.test(name) || name.endsWith(SEALED_SUFFIX)) continue;
    const file = path.join(dir, name);
    if (readSecretFile(file) != null && !fs.existsSync(file)) moved++;
  }
  return moved;
}

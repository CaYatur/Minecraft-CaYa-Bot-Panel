import * as crypto from "crypto";
import * as path from "path";
import { readSecretJson, writeSecretJson } from "../../security/secretBox";

/**
 * prismarine-auth cache that keeps tokens in memory and only persists them
 * through the shared secret helper. With an encryption key, plaintext token
 * JSON never touches the disk.
 *
 * File names match the library's own file cache
 * (`<sha1(username)[0..6]>_<cacheName>-cache.json`) so older plaintext
 * caches are found and migrated on first read.
 */
const memory = new Map<string, Record<string, unknown>>();

export function authCacheFileName(username: string, cacheName: string): string {
  const hash = crypto.createHash("sha1").update(username ?? "", "binary").digest("hex").slice(0, 6);
  return `${hash}_${cacheName}-cache.json`;
}

export class EncryptedAuthCache {
  constructor(readonly file: string) {}

  async reset(): Promise<void> {
    await this.setCached({});
  }

  async getCached(): Promise<Record<string, unknown>> {
    let value = memory.get(this.file);
    if (!value) {
      const loaded = readSecretJson<Record<string, unknown>>(this.file, {});
      value = loaded && typeof loaded === "object" ? loaded : {};
      memory.set(this.file, value);
    }
    return value;
  }

  async setCached(value: Record<string, unknown>): Promise<void> {
    const next = value && typeof value === "object" ? value : {};
    memory.set(this.file, next);
    writeSecretJson(this.file, next);
  }

  async setCachedPartial(value: Record<string, unknown>): Promise<void> {
    const current = await this.getCached();
    await this.setCached({ ...current, ...value });
  }
}

/** Factory accepted by prismarine-auth (and mineflayer's `profilesFolder`). */
export function encryptedCacheFactory(dir: string) {
  return ({ cacheName, username }: { cacheName: string; username: string }) =>
    new EncryptedAuthCache(path.join(dir, authCacheFileName(username, cacheName)));
}

/** Drops in-memory tokens for a folder (sign-out / remove). */
export function forgetCachedTokens(dir: string): void {
  const prefix = path.join(dir, path.sep);
  for (const file of [...memory.keys()]) if (file.startsWith(prefix)) memory.delete(file);
}

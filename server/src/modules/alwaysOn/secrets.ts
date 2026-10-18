import * as path from "path";
import { DATA_DIR } from "../../config/paths";
import { readSecretJson, writeSecretJson } from "../../security/secretBox";

const FILE = "login-secrets.json";

function file(): string {
  return path.join(DATA_DIR, FILE);
}

function readAll(): Record<string, string> {
  const parsed = readSecretJson<Record<string, string>>(file(), {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeAll(data: Record<string, string>): void {
  writeSecretJson(file(), data);
}

/** Startup migration: seals an older plaintext file. */
export function migrateLoginSecrets(): void {
  readAll();
}

export function hasLoginSecret(botId: string): boolean {
  return Boolean(readAll()[botId]);
}

export function readLoginSecret(botId: string): string | null {
  const value = readAll()[botId];
  return value ? String(value) : null;
}

export function writeLoginSecret(botId: string, password: string): void {
  const data = readAll();
  // Passwords are stored exactly as typed: leading/trailing spaces can be part of them.
  const value = String(password ?? "");
  if (!value) delete data[botId];
  else data[botId] = value;
  writeAll(data);
}

export function deleteLoginSecret(botId: string): void {
  const data = readAll();
  if (!data[botId]) return;
  delete data[botId];
  writeAll(data);
}

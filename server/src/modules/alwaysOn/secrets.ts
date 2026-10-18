import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../../config/paths";

const FILE = "login-secrets.json";

function file(): string {
  return path.join(DATA_DIR, FILE);
}

function readAll(): Record<string, string> {
  try {
    if (!fs.existsSync(file())) return {};
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, string>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file());
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
  const clean = password.trim();
  if (!clean) delete data[botId];
  else data[botId] = clean;
  writeAll(data);
}

export function deleteLoginSecret(botId: string): void {
  const data = readAll();
  if (!data[botId]) return;
  delete data[botId];
  writeAll(data);
}

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { createLogger } from "../utils/logger";
import { redactSecrets } from "../utils/redact";

const log = createLogger("secrets");

/**
 * Account name used for the Windows ACL. USERNAME can be empty (services,
 * some shells), so fall back to the OS account, then to the well-known
 * "Owner Rights" SID so the call is never skipped.
 */
export function aclPrincipal(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = String(env.USERNAME || "").trim();
  if (fromEnv) return env.USERDOMAIN ? `${env.USERDOMAIN}\\${fromEnv}` : fromEnv;
  try {
    const name = os.userInfo().username.trim();
    if (name) return name;
  } catch {
    /* fall through */
  }
  return "*S-1-3-4";
}

export function icaclsArgs(dir: string, principal: string): string[] {
  return [dir, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`, "/grant:r", "*S-1-5-18:(OI)(CI)F", "/T", "/C", "/Q"];
}

/** Restricts a folder (recursively) to the current user. Best effort, never throws. */
export function restrictToCurrentUser(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return;
    if (process.platform === "win32") {
      execFile("icacls", icaclsArgs(dir, aclPrincipal()), { windowsHide: true }, (err) => {
        if (err) log.warn("Could not restrict data folder permissions", redactSecrets(String(err.message)));
      });
      return;
    }
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    log.warn("Could not restrict data folder permissions", redactSecrets(String(err)));
  }
}

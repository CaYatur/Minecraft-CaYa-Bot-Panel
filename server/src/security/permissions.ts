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

/**
 * Hardening is applied to the top folder only. Its ACEs are inheritable
 * ((OI)(CI)), so Windows propagates them to every file and subfolder. The
 * earlier recursive (/T) form could leave files with an empty DACL when the
 * grant did not match, which made them unreadable even to their owner.
 */
export function icaclsArgs(dir: string, principal: string): string[] {
  return [dir, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`, "/grant:r", "*S-1-5-18:(OI)(CI)F", "/C", "/Q"];
}

/**
 * Recovery for files locked by the old recursive run: the user still owns
 * them, so resetting every child to "inherit from parent" restores access.
 * Runs before hardening on each start.
 */
export function icaclsResetArgs(dir: string): string[] {
  return [dir, "/reset", "/T", "/C", "/Q"];
}

/** Takes ownership (recursively) if a reset is refused; only used as a fallback. */
export function takeownArgs(dir: string): string[] {
  return ["/F", dir, "/R", "/D", "Y"];
}

type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

const runCmd: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });

/** Current user's SID from `whoami /user`, which never depends on USERNAME. */
async function currentUserSid(run: Run): Promise<string | null> {
  const res = await run("whoami", ["/user", "/fo", "csv", "/nh"]);
  const match = res.ok ? /S-1-5-[0-9-]+/.exec(res.out) : null;
  return match ? match[0] : null;
}

/**
 * Windows: reset children (recovery), then harden the top folder. Unix: chmod
 * 0700. Best effort, never throws. `run` is injectable for tests.
 */
export async function hardenDataDir(dir: string, platform: NodeJS.Platform = process.platform, run: Run = runCmd): Promise<string[]> {
  const steps: string[] = [];
  try {
    if (!fs.existsSync(dir)) return steps;
    if (platform !== "win32") {
      fs.chmodSync(dir, 0o700);
      steps.push("chmod");
      return steps;
    }
    let reset = await run("icacls", icaclsResetArgs(dir));
    steps.push("reset");
    if (!reset.ok) {
      await run("takeown", takeownArgs(dir));
      steps.push("takeown");
      reset = await run("icacls", icaclsResetArgs(dir));
      steps.push("reset");
      if (!reset.ok) log.warn("Could not reset data folder permissions", redactSecrets(reset.out.slice(0, 300)));
    }
    const sid = await currentUserSid(run);
    const principal = sid ? `*${sid}` : aclPrincipal();
    const harden = await run("icacls", icaclsArgs(dir, principal));
    steps.push("harden");
    if (!harden.ok) log.warn("Could not restrict data folder permissions", redactSecrets(harden.out.slice(0, 300)));
  } catch (err) {
    log.warn("Could not restrict data folder permissions", redactSecrets(String(err)));
  }
  return steps;
}

/** Unix-only per-folder tightening; on Windows the data root ACL is inherited. */
export function restrictToCurrentUser(dir: string): void {
  if (process.platform === "win32" || process.env.CAYA_SKIP_ACL === "1") return;
  try {
    if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
  } catch (err) {
    log.warn("Could not restrict folder permissions", redactSecrets(String(err)));
  }
}

import type { IncomingMessage } from "http";
import type { NextFunction, Request, Response } from "express";
import { createLogger } from "../utils/logger";

const log = createLogger("security");

/**
 * Host/Origin checks for the REST API, socket.io and /mcp.
 *
 * - Host must be a loopback name (or an entry from CAYA_ALLOWED_HOSTS). This
 *   blocks DNS rebinding, where a web page points its own domain at 127.0.0.1.
 * - A browser Origin, when present, must be loopback, same-origin with Host,
 *   or listed in CAYA_ALLOWED_HOSTS. This blocks cross-site requests (CSRF)
 *   from any web page the user has open.
 * - Requests without Origin (MCP clients, curl, scripts) are allowed unless
 *   the browser marks them as cross-site.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface GuardOptions {
  /** Address the server is bound to (CAYA_HOST). */
  bindHost: string;
  /** Extra host names allowed, from CAYA_ALLOWED_HOSTS (comma separated). */
  allowedHosts?: string[];
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Host name without port, lower-case. Handles bracketed IPv6. */
export function hostName(hostHeader: string | undefined | null): string | null {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  if (!raw || raw.length > 255) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(0, end + 1) : null;
  }
  const colon = raw.indexOf(":");
  const name = colon >= 0 ? raw.slice(0, colon) : raw;
  return /^[a-z0-9.-]+$/.test(name) ? name : null;
}

function isLoopbackName(name: string): boolean {
  return LOOPBACK.has(name) || /^127(\.\d{1,3}){3}$/.test(name);
}

function hostAllowed(name: string, opts: GuardOptions): boolean {
  if (isLoopbackName(name)) return true;
  const allowed = opts.allowedHosts ?? [];
  if (allowed.includes(name)) return true;
  const bind = opts.bindHost.toLowerCase();
  // An explicit LAN address the user bound to is accepted as Host as well.
  return bind !== "0.0.0.0" && bind !== "::" && !isLoopbackName(bind) && name === bind;
}

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

export function checkRequest(
  headers: { host?: string; origin?: string; "sec-fetch-site"?: string | string[] },
  opts: GuardOptions
): GuardVerdict {
  const host = hostName(headers.host);
  if (!host || !hostAllowed(host, opts)) return { ok: false, reason: "host" };
  const origin = typeof headers.origin === "string" ? headers.origin.trim() : "";
  if (origin && origin !== "null") {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return { ok: false, reason: "origin" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "origin" };
    const originHost = url.hostname.toLowerCase();
    const sameOrigin = url.host.toLowerCase() === String(headers.host ?? "").trim().toLowerCase();
    if (!sameOrigin && !hostAllowed(originHost.includes(":") ? `[${originHost}]` : originHost, opts)) {
      return { ok: false, reason: "origin" };
    }
  } else if (origin === "null") {
    return { ok: false, reason: "origin" };
  } else {
    const site = String(headers["sec-fetch-site"] ?? "").toLowerCase();
    if (site === "cross-site") return { ok: false, reason: "cross-site" };
  }
  return { ok: true };
}

export function httpGuard(opts: GuardOptions) {
  let warned = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const verdict = checkRequest(req.headers as Record<string, string>, opts);
    if (verdict.ok) return next();
    if (warned++ < 20) log.warn(`Blocked ${req.method} ${req.path} (${verdict.reason} check failed)`);
    res.status(403).json({ error: "Request blocked: the panel only accepts requests from itself." });
  };
}

/** socket.io `allowRequest` hook using the same rules. */
export function socketGuard(opts: GuardOptions) {
  return (req: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
    const verdict = checkRequest(req.headers as Record<string, string>, opts);
    if (!verdict.ok) log.warn(`Blocked socket connection (${verdict.reason} check failed)`);
    callback(verdict.ok ? null : "forbidden", verdict.ok);
  };
}

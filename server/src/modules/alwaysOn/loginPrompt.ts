export type LoginPromptKind = "login" | "register" | "success" | "wrong_password" | "none";
export type LoginSendMode = "prompt" | "login" | "register_first";

/** A named player line. Those must not start a login or register. */
export function looksLikePlayerChat(plainText: string): boolean {
  const p = plainText.trim();
  if (/^<[^>\n]{1,48}>\s+\S/.test(p)) return true;
  if (/^[A-Za-z0-9_]{1,16}\s*(?:»|>>|:\s|whispers?\b)/i.test(p)) return true;
  return false;
}

export function loginSendMode(value: unknown): LoginSendMode {
  return value === "login" || value === "register_first" ? value : "prompt";
}

/** What to send on spawn when the server has not asked. */
export function unpromptedLoginKind(mode: LoginSendMode, registered: boolean): "login" | "register" | "none" {
  if (mode === "login") return "login";
  if (mode === "register_first") return registered ? "login" : "register";
  return "none";
}

function commandVerb(template: string): string {
  const match = template.trim().match(/^\/([A-Za-z0-9_]+)/);
  return match?.[1] ?? "";
}

/** Classify an AuthMe-style system line. Success and rejection win over a generic login prompt. */
export function detectLoginPrompt(plainText: string, extraPattern = "", loginTemplate = "", registerTemplate = ""): LoginPromptKind {
  const p = plainText.trim();
  if (!p || looksLikePlayerChat(p)) return "none";
  if (/wrong\s+password|yanl[ıi]s\s+sifre|yanlış\s+şifre|incorrect\s+password|bad\s+password/i.test(p)) return "wrong_password";
  if (/başarıyla\s+giriş|basariyla\s+giris|successfully\s+logged|logged\s+in\s+successfully|giriş\s+yaptınız|giris\s+yaptiniz/i.test(p)) {
    return "success";
  }
  if (extraPattern.trim()) {
    try {
      if (new RegExp(extraPattern, "i").test(p)) return "login";
    } catch {
      /* ignore a broken extra pattern */
    }
  }
  const unregistered = /not\s+registered|isn.?t\s+registered|(kayıt|kayit)\s+(ol|yok|edilmem)/i.test(p);
  const mentionsRegister = /\/register\b|\/reg\b/i.test(p);
  const mentionsLogin = /\/login\b|\/l\b|please.{0,40}(login|log in)|lütfen.{0,40}(giriş|login)/i.test(p);
  if (unregistered) return "register";
  if (mentionsLogin) return "login";
  if (mentionsRegister) return "register";
  const registerVerb = commandVerb(registerTemplate);
  const loginVerb = commandVerb(loginTemplate);
  if (registerVerb && new RegExp(`(?:^|\\s)/${registerVerb}\\b`, "i").test(p)) return "register";
  if (loginVerb && new RegExp(`(?:^|\\s)/${loginVerb}\\b`, "i").test(p)) return "login";
  return "none";
}

export type PasswordRepeat = 1 | 2;

export function passwordRepeat(value: unknown, fallback: PasswordRepeat): PasswordRepeat {
  return value === 2 || value === "2" ? 2 : value === 1 || value === "1" ? 1 : fallback;
}

/** Build /login or /register. A template such as `/l {password}` replaces the preset. */
export function loginPluginCommand(kind: "login" | "register", password: string, repeat: PasswordRepeat, template = ""): string {
  const custom = template.trim();
  if (custom) return custom.replaceAll("{password}", password);
  const times = repeat === 2 ? 2 : 1;
  const args = Array.from({ length: times }, () => password).join(" ");
  return `/${kind} ${args}`;
}

/** Empty is allowed. Otherwise the command must start with / and contain {password}. */
export function normalizeLoginTemplate(raw: unknown): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length > 80 || !/^\/[A-Za-z0-9_]+(?:\s+(?:\{password\}|[A-Za-z0-9_.:-]{1,32})){1,6}$/.test(text) || !text.includes("{password}")) {
    throw new Error("A custom command must start with / and include {password}. Example: /l {password}");
  }
  return text;
}

/** Hide every /login and /register argument before chat history, logs, or Discord. */
export function redactGameCommand(text: string): string {
  return text.replace(/(\/(?:login|register|reg|l)\b)(\s+\S+)+/gi, (match, command: string) => {
    const count = match.slice(command.length).trim().split(/\s+/).filter(Boolean).length;
    return `${command} ${Array.from({ length: count }, () => "••••").join(" ")}`;
  });
}

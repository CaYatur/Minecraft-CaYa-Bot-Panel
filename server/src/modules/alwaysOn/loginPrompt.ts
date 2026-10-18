export type LoginPromptKind = "login" | "register" | "success" | "wrong_password" | "none";

/** Classify an AuthMe-style system line. Success and rejection win over a generic login prompt. */
export function detectLoginPrompt(plainText: string, extraPattern = ""): LoginPromptKind {
  const p = plainText.trim();
  if (!p) return "none";
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
  if (/\/register\b|\/reg\b|not\s+registered|(kayıt|kayit)\s+ol/i.test(p)) return "register";
  if (/\/login\b|\/l\b|please.{0,40}(login|log in)|lütfen.{0,40}(giriş|login)/i.test(p)) return "login";
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

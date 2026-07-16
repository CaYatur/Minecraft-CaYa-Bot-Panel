/**
 * Minimal Ollama HTTP client (native fetch, no deps).
 * Uses /api/chat with tool calling (stream:false) — works with tool-capable
 * models such as llama3.1+, qwen2.5/3, mistral-nemo, command-r...
 */

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** newer ollama versions accept the tool name on tool-result messages */
  tool_name?: string;
}

export interface OllamaToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatOptions {
  host: string;
  model: string;
  temperature?: number;
  numCtx?: number;
  keepAlive?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function baseUrl(host: string): string {
  let h = (host || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(h)) h = "http://" + h;
  return h;
}

function friendlyOllamaError(err: unknown, host: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|network|abort/i.test(msg)) {
    return new Error(
      `Ollama'ya ulaşılamadı (${host}). Ollama çalışıyor mu? Kur: https://ollama.com · Başlat: "ollama serve" · (${msg})`
    );
  }
  return new Error(msg);
}

export async function ollamaVersion(host: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl(host)}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { version?: string };
    return data.version ?? "unknown";
  } catch (err) {
    throw friendlyOllamaError(err, host);
  }
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  family?: string;
  parameterSize?: string;
}

export async function ollamaListModels(host: string): Promise<OllamaModelInfo[]> {
  try {
    const res = await fetch(`${baseUrl(host)}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      models?: Array<{ name: string; size?: number; details?: { family?: string; parameter_size?: string } }>;
    };
    return (data.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? 0,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size
    }));
  } catch (err) {
    throw friendlyOllamaError(err, host);
  }
}

export async function ollamaChat(
  opts: OllamaChatOptions,
  messages: OllamaMessage[],
  tools: OllamaToolSpec[]
): Promise<OllamaMessage> {
  const url = `${baseUrl(opts.host)}/api/chat`;
  const body = {
    model: opts.model,
    messages,
    stream: false,
    keep_alive: opts.keepAlive ?? "5m",
    tools: tools.length ? tools : undefined,
    options: {
      temperature: opts.temperature ?? 0.7,
      num_ctx: opts.numCtx ?? 8192
    }
  };
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 180_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    throw friendlyOllamaError(err, opts.host);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    if (res.status === 404 && /model/i.test(errBody)) {
      throw new Error(`Model "${opts.model}" Ollama'da yüklü değil — terminalde çalıştır: ollama pull ${opts.model}`);
    }
    if (/does not support tools/i.test(errBody)) {
      throw new Error(
        `Model "${opts.model}" araç (tool) çağrısını desteklemiyor — llama3.1, qwen2.5, qwen3 veya mistral-nemo gibi tool destekli bir model seç.`
      );
    }
    throw new Error(`Ollama hata ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as { message?: OllamaMessage; error?: string };
  if (data.error) throw new Error(`Ollama: ${data.error}`);
  if (!data.message) throw new Error("Ollama boş yanıt döndürdü");
  return data.message;
}

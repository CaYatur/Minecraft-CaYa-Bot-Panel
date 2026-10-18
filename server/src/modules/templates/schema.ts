export const TEMPLATE_SCHEMA = "caya.automation-template";
export const TEMPLATE_VERSION = 1;
export const MAX_TEMPLATE_BYTES = 256_000;
export const MAX_TEMPLATE_RULES = 20;

export interface TemplateRule {
  name?: string;
  enabled?: boolean;
  botIds?: string[] | "all";
  trigger?: Record<string, unknown>;
  conditions?: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
  elseActions?: Array<Record<string, unknown>>;
  onErrorActions?: Array<Record<string, unknown>>;
  cooldownMs?: number;
  maxTriggersPerMinute?: number;
}

export interface TemplateFile {
  schema: typeof TEMPLATE_SCHEMA;
  version: number;
  name: string;
  description: string;
  rules: TemplateRule[];
}

const SECRET_KEY = /password|token|webhook|secret/i;

export function validateTemplate(
  input: unknown,
  allowedActions: ReadonlySet<string>
): { ok: boolean; errors: string[]; warnings: string[]; template?: TemplateFile } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? null);
  if (Buffer.byteLength(raw, "utf8") > MAX_TEMPLATE_BYTES) errors.push("Template is larger than 256 KB.");
  let body: unknown = input;
  if (typeof input === "string") {
    try {
      body = JSON.parse(input);
    } catch {
      errors.push("Template is not valid JSON.");
      return { ok: false, errors, warnings };
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    errors.push("Template must be a JSON object.");
    return { ok: false, errors, warnings };
  }
  const obj = body as Record<string, unknown>;
  if (obj.schema !== TEMPLATE_SCHEMA) errors.push(`schema must be ${TEMPLATE_SCHEMA}.`);
  if (obj.version !== TEMPLATE_VERSION) errors.push(`version must be ${TEMPLATE_VERSION}.`);
  const name = String(obj.name ?? "").trim();
  const description = String(obj.description ?? "").trim();
  if (!name || name.length > 80) errors.push("name is required and must be at most 80 characters.");
  if (description.length > 400) errors.push("description must be at most 400 characters.");
  if (!Array.isArray(obj.rules) || obj.rules.length === 0) errors.push("rules must be a non-empty array.");
  if (Array.isArray(obj.rules) && obj.rules.length > MAX_TEMPLATE_RULES) errors.push(`At most ${MAX_TEMPLATE_RULES} rules.`);
  const rules: TemplateRule[] = [];
  if (Array.isArray(obj.rules)) {
    obj.rules.forEach((rule, index) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        errors.push(`Rule ${index + 1} is not an object.`);
        return;
      }
      const cleaned = stripSecrets(rule) as TemplateRule;
      const actions = [...asActions(cleaned.actions), ...asActions(cleaned.elseActions), ...asActions(cleaned.onErrorActions)];
      for (const action of actions) {
        const type = String(action.type ?? "");
        if (!allowedActions.has(type)) errors.push(`Rule ${index + 1} uses unknown action "${type || "(missing)"}".`);
      }
      if (JSON.stringify(rule).match(/password|token|webhookUrl|secret/i)) {
        warnings.push(`Rule ${index + 1} had secret-like fields removed.`);
      }
      const waypoint = actionWaypoint(cleaned);
      if (waypoint) warnings.push(`Rule ${index + 1} references waypoint "${waypoint}". It is not created by the import.`);
      delete (cleaned as { id?: string }).id;
      rules.push(cleaned);
    });
  }
  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    errors,
    warnings,
    template: { schema: TEMPLATE_SCHEMA, version: TEMPLATE_VERSION, name, description, rules }
  };
}

export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(child);
  }
  return out;
}

function asActions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
}

function actionWaypoint(rule: TemplateRule): string {
  const groups = [rule.actions, rule.elseActions, rule.onErrorActions];
  for (const group of groups) {
    for (const action of asActions(group)) {
      if (action.waypoint) return String(action.waypoint);
    }
  }
  return "";
}

export function templateFromRules(name: string, description: string, rules: unknown[]): TemplateFile {
  return {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name,
    description,
    rules: rules.map((rule) => {
      const copy = stripSecrets(rule) as TemplateRule & { id?: string };
      delete copy.id;
      return copy;
    })
  };
}

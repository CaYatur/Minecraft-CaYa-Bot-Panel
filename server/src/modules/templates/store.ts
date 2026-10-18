import { loadJson, saveJson } from "../../persistence/store";
import { newId } from "../../types";
import { bundledByName, BUNDLED_TEMPLATES, templateId } from "./bundled";
import { TEMPLATE_SCHEMA, TEMPLATE_VERSION, type TemplateFile } from "./schema";

const FILE = "user-templates.json";

export interface StoredTemplate extends TemplateFile {
  id: string;
}

function read(): StoredTemplate[] {
  return loadJson<StoredTemplate[]>(FILE, []).filter((row) => row && row.schema === TEMPLATE_SCHEMA);
}

export function listTemplates(): Array<{ id: string; name: string; description: string; version: number; source: "bundled" | "user" }> {
  const bundled = BUNDLED_TEMPLATES.map((template) => ({
    id: templateId(template.name),
    name: template.name,
    description: template.description,
    version: template.version,
    source: "bundled" as const
  }));
  const user = read().map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    version: template.version,
    source: "user" as const
  }));
  return [...bundled, ...user];
}

export function getTemplate(nameOrId: string): TemplateFile | undefined {
  return bundledByName(nameOrId) ?? read().find((row) => row.id === nameOrId || row.name.toLowerCase() === nameOrId.toLowerCase());
}

export function saveUserTemplate(template: TemplateFile): StoredTemplate {
  const rows = read().filter((row) => row.name.toLowerCase() !== template.name.toLowerCase());
  const stored: StoredTemplate = { ...template, schema: TEMPLATE_SCHEMA, version: TEMPLATE_VERSION, id: newId() };
  rows.push(stored);
  void saveJson(FILE, rows);
  return stored;
}

export function deleteUserTemplate(id: string): boolean {
  const rows = read();
  const next = rows.filter((row) => row.id !== id);
  if (next.length === rows.length) return false;
  void saveJson(FILE, next);
  return true;
}

import type { AutomationRule } from "./RuleEngine";
import { bundledBlueprints } from "../templates/bundled";

/** Kullanıcı blueprint’i (ileride kalıcı özel şablon for iskelet) */
export interface RuleBlueprint {
  id: string;
  name: string;
  category: string;
  description: string;
  rule: Partial<AutomationRule>;
}

/** Bundled examples from issue #30. The old Turkish stock names stay absent. */
export const RULE_BLUEPRINTS = bundledBlueprints() as RuleBlueprint[];

export function blueprintNames(): string[] {
  return RULE_BLUEPRINTS.map((b) => b.name);
}

export function findBlueprint(nameOrId: string): RuleBlueprint | undefined {
  const q = nameOrId.toLowerCase();
  return RULE_BLUEPRINTS.find((b) => b.id === nameOrId || b.name.toLowerCase() === q);
}

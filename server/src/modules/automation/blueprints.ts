import type { AutomationRule } from "./RuleEngine";

/** Kullanıcı blueprint’i (ileride kalıcı özel şablon için iskelet) */
export interface RuleBlueprint {
  id: string;
  name: string;
  category: string;
  description: string;
  rule: Partial<AutomationRule>;
}

/**
 * Hazır stok şablonlar KALDIRILDI — kullanıcı paneldan kural oluşturur / düzenler.
 * Geriye uyum: boş dizi (API kırılmasın).
 */
export const RULE_BLUEPRINTS: RuleBlueprint[] = [];

export function blueprintNames(): string[] {
  return RULE_BLUEPRINTS.map((b) => b.name);
}

export function findBlueprint(nameOrId: string): RuleBlueprint | undefined {
  const q = nameOrId.toLowerCase();
  return RULE_BLUEPRINTS.find((b) => b.id === nameOrId || b.name.toLowerCase() === q);
}

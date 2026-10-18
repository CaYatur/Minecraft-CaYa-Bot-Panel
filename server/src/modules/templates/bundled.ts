import { TEMPLATE_SCHEMA, TEMPLATE_VERSION, type TemplateFile } from "./schema";

const idle = [{ type: "task_idle" as const }];

export const BUNDLED_TEMPLATES: TemplateFile[] = [
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: "Auto farm",
    description: "One wheat farm cycle while the bot is idle. Enable it and stay near the field.",
    rules: [
      {
        name: "Auto farm",
        enabled: false,
        trigger: { type: "interval", everyMs: 60_000 },
        conditions: idle,
        actions: [{ type: "farm-cycle", crop: "wheat_seeds", radius: 4, maxCycles: 1 }]
      }
    ]
  },
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: "AFK fisher",
    description: "Cast a fishing rod while idle. The bot needs a fishing rod in its inventory.",
    rules: [
      {
        name: "AFK fisher",
        enabled: false,
        trigger: { type: "interval", everyMs: 30_000 },
        conditions: idle,
        actions: [{ type: "fish" }]
      }
    ]
  },
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: "Mob grinder guard",
    description: "Clear hostile mobs near the bot while it is idle.",
    rules: [
      {
        name: "Mob grinder guard",
        enabled: false,
        trigger: { type: "interval", everyMs: 8_000 },
        conditions: idle,
        actions: [{ type: "clear-mobs", radius: 8 }]
      }
    ]
  },
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: "Auto eat and sleep",
    description: "Eat when hungry, and sleep at night when a bed is nearby.",
    rules: [
      {
        name: "Auto eat",
        enabled: false,
        trigger: { type: "interval", everyMs: 15_000 },
        conditions: [{ type: "food_below", threshold: 14 }],
        actions: [{ type: "eat" }]
      },
      {
        name: "Sleep at night",
        enabled: false,
        trigger: { type: "interval", everyMs: 20_000 },
        conditions: [{ type: "time_night" }, { type: "task_idle" }],
        actions: [{ type: "sleep" }]
      }
    ]
  }
];

export function bundledBlueprints(): Array<{
  id: string;
  name: string;
  category: string;
  description: string;
  rule: TemplateFile["rules"][number];
}> {
  return BUNDLED_TEMPLATES.map((template) => ({
    id: templateId(template.name),
    name: template.name,
    category: "Bundled",
    description: template.description,
    rule: template.rules[0] ?? { name: template.name }
  }));
}

export function templateId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function bundledByName(nameOrId: string): TemplateFile | undefined {
  const q = nameOrId.toLowerCase();
  return BUNDLED_TEMPLATES.find((template) => template.name.toLowerCase() === q || templateId(template.name) === q);
}

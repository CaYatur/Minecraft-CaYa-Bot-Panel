# Automation templates

A template is JSON:

```json
{
  "schema": "caya.automation-template",
  "version": 1,
  "name": "Example",
  "description": "What it does",
  "rules": []
}
```

The file must be at most 256 KB and at most 20 rules. Every action type has to be one of the panel actions. Unknown actions are rejected and nothing is created. Fields whose names look like a password, token, webhook, or secret are removed before save. A waypoint name is kept, and the import warns that the waypoint itself is not created.

Bundled examples are Auto farm, AFK fisher, Mob grinder guard, and Auto eat and sleep. They arrive disabled. Import them from Automations, or `POST /api/rules/templates/<name>`. Preview with `POST /api/rules/import` and `"apply": false` before creating rules.

Exported rules use the same schema. They do not include login-plugin passwords or Discord tokens.

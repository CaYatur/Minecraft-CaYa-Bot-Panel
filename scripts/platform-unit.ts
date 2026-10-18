/**
 * Always-on, template, and Discord checks that do not open a Minecraft server
 * or a Discord gateway.
 */
import * as http from "http";
import { nextBackoffMs, sessionIsStable } from "../server/src/modules/alwaysOn/backoff";
import { classifyDisconnect } from "../server/src/modules/alwaysOn/classify";
import { detectLoginPrompt, redactGameCommand } from "../server/src/modules/alwaysOn/loginPrompt";
import { antiAfkAllowed } from "../server/src/modules/alwaysOn/antiAfk";
import { describeScene, inViewCone } from "../server/src/modules/view/describe";
import { ACTION_META } from "../server/src/modules/automation/RuleEngine";
import { BUNDLED_TEMPLATES } from "../server/src/modules/templates/bundled";
import { validateTemplate } from "../server/src/modules/templates/schema";
import { allowSend, escapeDiscordMentions, isAllowlisted, sayIsBlocked, shouldBridgeDiscord, shouldBridgeMinecraft } from "../server/src/modules/discord/logic";
import { postWebhook } from "../server/src/modules/discord/hub";

let failures = 0;
const ok = (name: string) => console.log(`  ok ${name}`);
const fail = (name: string, detail?: string) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) ok(name);
  else fail(name, detail);
}

function unit() {
  const delays = [0, 1, 2, 3].map((attempt) => nextBackoffMs({ attempt, baseMs: 5000, maxMs: 20000, jitter: 0, random: () => 0.5 }));
  assert("backoff grows and then caps", delays[0] === 5000 && delays[1] === 10000 && delays[2] === 20000 && delays[3] === 20000, delays.join(","));
  assert("a two minute session is stable", sessionIsStable(120_000, 120_000) && !sessionIsStable(10_000, 120_000));

  assert("ban does not retry", !classifyDisconnect("You are banned from this server").retry);
  assert("whitelist does not retry", !classifyDisconnect("You are not whitelisted").retry);
  assert("restart retries", classifyDisconnect("Server closed").retry && classifyDisconnect("Server closed").kind === "restart");
  assert("timeout retries", classifyDisconnect("Timed out").retry);

  assert("login prompt", detectLoginPrompt("/login <password>") === "login");
  assert("register prompt", detectLoginPrompt("Please /register") === "register");
  assert("success wins over login", detectLoginPrompt("Successfully logged in") === "success");
  assert("wrong password", detectLoginPrompt("Wrong password") === "wrong_password");
  assert("password is redacted", redactGameCommand("/login hunter2").includes("••••") && !redactGameCommand("/login hunter2").includes("hunter2"));
  assert("anti-afk waits for an idle grounded bot", antiAfkAllowed({ enabled: true, taskRunning: false, onGround: true }) && !antiAfkAllowed({ enabled: true, taskRunning: true, onGround: true }));

  const allowed = new Set(ACTION_META.map((row) => row.type));
  for (const template of BUNDLED_TEMPLATES) {
    const checked = validateTemplate(template, allowed);
    assert(`bundled template ${template.name} is valid`, checked.ok, checked.errors.join("; "));
  }
  const evil = validateTemplate({ schema: "caya.automation-template", version: 1, name: "Bad", description: "", rules: [{ actions: [{ type: "eval", code: "process.exit()" }] }] }, allowed);
  assert("unknown action is rejected", !evil.ok);
  const secret = validateTemplate({
    schema: "caya.automation-template",
    version: 1,
    name: "Secret",
    description: "",
    rules: [{ actions: [{ type: "send_chat", text: "hi", password: "hunter2" }] }]
  }, allowed);
  assert("secret fields are stripped", secret.ok && !JSON.stringify(secret.template).includes("hunter2"));

  const origin = { x: 0, y: 0, z: 0 };
  assert("forward block is in view", inViewCone(origin, 0, 0, 70, { x: 0, y: 0, z: 5 }));
  assert("block behind is out of view", !inViewCone(origin, 0, 0, 70, { x: 0, y: 0, z: -5 }));
  const scene = describeScene({
    origin,
    yaw: 0,
    pitch: 0,
    fov: 70,
    blocks: [{ name: "grass_block", x: 0, y: 0, z: 2 }],
    entities: [{ name: "Steve", x: 0, y: 0, z: 3, kind: "player" }],
    crosshair: { type: "block", name: "grass_block", distance: 2 }
  });
  assert("description keeps the visible player and block", scene.blocks.some((row) => row.name === "grass_block") && scene.entities.some((row) => row.name === "Steve"));

  assert("mentions are escaped", !escapeDiscordMentions("hi @everyone").includes("@everyone"));
  assert("empty allowlist denies", !isAllowlisted("1", ["9"], { userIds: [], roleIds: [] }));
  assert("allowlisted user is accepted", isAllowlisted("1", [], { userIds: ["1"], roleIds: [] }));
  assert("slash say is blocked", sayIsBlocked("/op Steve", false) && !sayIsBlocked("hello", false));
  assert("own minecraft line is not bridged", !shouldBridgeMinecraft({ self: true, username: "Bot", botName: "Bot", text: "hi" }));
  assert("discord echo is not bridged back", !shouldBridgeDiscord({ authorIsBot: true, text: "[MC] Bot: hi" }));
  const history: number[] = [];
  assert("bridge rate limit holds", allowSend(history, 1_000, 1) && !allowSend(history, 1_100, 1));
}

function webhook(): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { content?: string; allowed_mentions?: { parse?: string[] } };
        assert("webhook body escapes mentions and disables pings", parsed.content?.includes("@\u200beveryone") && parsed.allowed_mentions?.parse?.length === 0);
        res.writeHead(204);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const result = await postWebhook(`http://127.0.0.1:${port}/hook`, "hello @everyone");
      assert("local webhook accepts the test", result.ok, result.error);
      server.close(() => resolve());
    });
  });
}

void (async () => {
  unit();
  await webhook();
  if (failures) {
    console.log(`platform failed (${failures})`);
    process.exit(1);
  }
  console.log("platform passed");
})();

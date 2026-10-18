/**
 * Always-on, template, and Discord checks that do not open a Minecraft server
 * or a Discord gateway.
 */
import * as http from "http";
import { nextBackoffMs, sessionIsStable } from "../server/src/modules/alwaysOn/backoff";
import { classifyDisconnect } from "../server/src/modules/alwaysOn/classify";
import { detectLoginPrompt, loginPluginCommand, normalizeLoginTemplate, redactGameCommand } from "../server/src/modules/alwaysOn/loginPrompt";
import { antiAfkAllowed, pickAntiAfkAction } from "../server/src/modules/alwaysOn/antiAfk";
import { describeScene, inViewCone } from "../server/src/modules/view/describe";
import { runWithLocalViewerServer } from "../server/src/modules/view/session";
import { renderProbePng } from "../server/src/modules/view/headlessCanvas";
import { ACTION_META } from "../server/src/modules/automation/RuleEngine";
import { BUNDLED_TEMPLATES } from "../server/src/modules/templates/bundled";
import { validateTemplate } from "../server/src/modules/templates/schema";
import { allowSend, escapeDiscordMentions, isAllowlisted, sayIsBlocked, shouldBridgeDiscord, shouldBridgeMinecraft } from "../server/src/modules/discord/logic";
import { postWebhook } from "../server/src/modules/discord/hub";
import { chatComponentToText } from "../server/src/utils/chatText";

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
  assert("both commands use login", detectLoginPrompt("Please /register or /login <password>") === "login");
  assert("unregistered account uses register", detectLoginPrompt("You are not registered. Use /register") === "register");
  assert("kick nbt is readable", chatComponentToText({ type: "compound", value: { text: { type: "string", value: "Kicked for idling" } } }) === "Kicked for idling");
  assert("success wins over login", detectLoginPrompt("Successfully logged in") === "success");
  assert("wrong password", detectLoginPrompt("Wrong password") === "wrong_password");
  assert("password is redacted", redactGameCommand("/login hunter2").includes("••••") && !redactGameCommand("/login hunter2").includes("hunter2"));
  assert("both password copies are redacted", !redactGameCommand("/register hunter2 hunter2").includes("hunter2") && redactGameCommand("/login one two").split("••••").length === 3);
  assert("login can repeat the password", loginPluginCommand("login", "secret", 1) === "/login secret" && loginPluginCommand("login", "secret", 2) === "/login secret secret");
  assert("register can take one password", loginPluginCommand("register", "secret", 1) === "/register secret" && loginPluginCommand("register", "secret", 2) === "/register secret secret");
  assert("custom login command uses the placeholder", loginPluginCommand("login", "secret", 1, "/l {password}") === "/l secret");
  assert("custom command must keep the placeholder", (() => { try { normalizeLoginTemplate("/login hunter2"); return false; } catch { return normalizeLoginTemplate("/l {password}") === "/l {password}"; } })());
  assert("anti-afk waits for an idle grounded bot", antiAfkAllowed({ enabled: true, taskRunning: false, onGround: true }) && !antiAfkAllowed({ enabled: true, taskRunning: true, onGround: true }));
  assert("anti-afk mode repeats one action", pickAntiAfkAction(() => 0.99, "look") === "look" && pickAntiAfkAction(() => 0.99, "mixed") === "jump");

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

async function viewerBind() {
  let bound = "";
  const server = await new Promise<http.Server>((resolve, reject) => {
    void runWithLocalViewerServer(() => {
      const localHttp = require("http") as typeof http;
      const local = localHttp.createServer((_req, res) => {
        res.end("ok");
      });
      local.listen(0, () => resolve(local));
      local.on("error", reject);
    });
  });
  const address = server.address();
  if (address && typeof address === "object") bound = address.address;
  server.close();
  assert("3D viewer page binds to localhost", bound === "127.0.0.1", bound);
}

function glProbe() {
  const png = renderProbePng();
  const { createCanvas, loadImage } = require("canvas") as {
    createCanvas(w: number, h: number): { getContext(kind: "2d"): { drawImage(img: unknown, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } };
    loadImage(src: Buffer): Promise<{ width: number; height: number }>;
  };
  return loadImage(png).then((img) => {
    const surface = createCanvas(img.width, img.height);
    const ctx = surface.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 16) {
      const luma = (data[i] ?? 0) * 0.3 + (data[i + 1] ?? 0) * 0.59 + (data[i + 2] ?? 0) * 0.11;
      if (luma < min) min = luma;
      if (luma > max) max = luma;
    }
    assert("headless probe is a PNG", png.length > 100 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, `bytes=${png.length}`);
    assert("headless probe is not a blank frame", max - min > 20, `spread=${Math.round(max - min)}`);
  });
}

void (async () => {
  unit();
  await viewerBind();
  await glProbe();
  await webhook();
  if (failures) {
    console.log(`platform failed (${failures})`);
    process.exit(1);
  }
  console.log("platform passed");
})();

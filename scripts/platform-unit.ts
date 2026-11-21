/**
 * Always-on, template, and Discord checks that do not open a Minecraft server
 * or a Discord gateway.
 */
import * as http from "http";
import { nextBackoffMs, sessionIsStable } from "../server/src/modules/alwaysOn/backoff";
import { classifyDisconnect } from "../server/src/modules/alwaysOn/classify";
import { detectLoginPrompt, loginPluginCommand, looksLikePlayerChat, normalizeLoginTemplate, redactGameCommand, unpromptedLoginKind } from "../server/src/modules/alwaysOn/loginPrompt";
import { antiAfkAllowed, antiAfkAllowsAction, clampAntiAfkHold, clampAntiAfkInterval, clampAutostartDelaySec, pickAntiAfkAction } from "../server/src/modules/alwaysOn/antiAfk";
import { describeScene, inViewCone } from "../server/src/modules/view/describe";
import { renderSnapshot, runWithLocalViewerServer, viewerSupport } from "../server/src/modules/view/session";
import { buildStateRemap, remapColumnJson, substituteBlockName } from "../server/src/modules/view/remap";
import { patchedNodeWorkerFile, patchedPageFile } from "../server/src/modules/view/heightPatch";
import mcDataLoader from "minecraft-data";
import { renderProbePng } from "../server/src/modules/view/headlessCanvas";
import { ACTION_META } from "../server/src/modules/automation/RuleEngine";
import { BUNDLED_TEMPLATES } from "../server/src/modules/templates/bundled";
import { validateTemplate } from "../server/src/modules/templates/schema";
import { allowSend, escapeDiscordMentions, isAllowlisted, sayIsBlocked, shouldBridgeDiscord, shouldBridgeMinecraft } from "../server/src/modules/discord/logic";
import { postWebhook } from "../server/src/modules/discord/hub";
import { chatComponentToText } from "../server/src/utils/chatText";
import { COMMAND_TREE_LIMITS, flattenCommandNodes, flattenDeclarePacket, type CommandNode } from "../server/src/modules/chat/commandTree";
import { clickButton, describeWindow, clampHotbar, findWindowSlot, snapshotWindow } from "../server/src/modules/window";
import { ACTION_META, TRIGGER_META, guiActionInput } from "../server/src/modules/automation/RuleEngine";
import { BULK_ACTION_CATEGORY, BULK_ACTIONS, bulkActionType, normalizeBulkIds } from "../server/src/modules/bulk";

type McBlocks = { blocksByName: Record<string, { minStateId: number; maxStateId: number; defaultState: number } | undefined> };
const mcData = (v: string) => (mcDataLoader as unknown as (v: string) => McBlocks)(v);

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
  assert("a player login line is ignored", looksLikePlayerChat("<Steve> /login secret") && detectLoginPrompt("<Steve> /login secret") === "none" && detectLoginPrompt("<Steve> /giris", "", "/giris {password}", "") === "none");
  assert("a custom server command is recognized", detectLoginPrompt("Use /giris to continue", "", "/giris {password}", "/kayit {password}") === "login" && detectLoginPrompt("Use /kayit now", "", "/giris {password}", "/kayit {password}") === "register");
  assert("join send mode picks login or the first register", unpromptedLoginKind("prompt", false) === "none" && unpromptedLoginKind("login", false) === "login" && unpromptedLoginKind("register_first", false) === "register" && unpromptedLoginKind("register_first", true) === "login");
  assert("kick nbt is readable", chatComponentToText({ type: "compound", value: { text: { type: "string", value: "Kicked for idling" } } }) === "Kicked for idling");
  assert("success wins over login", detectLoginPrompt("Successfully logged in") === "success");
  assert("wrong password", detectLoginPrompt("Wrong password") === "wrong_password");
  assert("password is redacted", redactGameCommand("/login hunter2").includes("••••") && !redactGameCommand("/login hunter2").includes("hunter2"));
  assert("both password copies are redacted", !redactGameCommand("/register hunter2 hunter2").includes("hunter2") && redactGameCommand("/login one two").split("••••").length === 3);
  assert("login can repeat the password", loginPluginCommand("login", "secret", 1) === "/login secret" && loginPluginCommand("login", "secret", 2) === "/login secret secret");
  assert("register can take one password", loginPluginCommand("register", "secret", 1) === "/register secret" && loginPluginCommand("register", "secret", 2) === "/register secret secret");
  assert("custom login command uses the placeholder", loginPluginCommand("login", "secret", 1, "/l {password}") === "/l secret");
  assert("custom command must keep the placeholder", (() => { try { normalizeLoginTemplate("/login hunter2"); return false; } catch { return normalizeLoginTemplate("/l {password}") === "/l {password}"; } })());
  {
    const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
    assert("GUI click types map and unknown ones are refused", clickButton(undefined) === "left" && clickButton("SHIFT") === "shift" && throws(() => clickButton("double")));
    assert("hotbar stays 0-8", clampHotbar(0) === 0 && clampHotbar("8") === 8 && throws(() => clampHotbar(9)) && throws(() => clampHotbar(-1)) && throws(() => clampHotbar(1.5)));
    const closed = snapshotWindow(null);
    assert("no bot means no open window", !closed.open && closed.slots.length === 0 && /No window is open/.test(describeWindow(closed)));
    const text = describeWindow({
      open: true, id: 7, type: "minecraft:generic_9x3", title: "Server Selector", containerSlots: 27, totalSlots: 63, heldQuickBar: 0, heldItem: "compass", ts: 0,
      slots: [null, { slot: 1, name: "grass_block", displayName: "Grass Block", customName: "OneBlock", lore: ["Click to join"], count: 1, section: "container" }, { slot: 40, name: "compass", displayName: "Compass", customName: null, lore: [], count: 1, section: "hotbar" }]
    });
    assert("window description lists menu slots with custom names and hides player rows", text.includes('slot 1 [container]: "OneBlock" (grass_block) ×1 — Click to join') && !text.includes("slot 40"), text);
    const menu = {
      open: true, id: 3, type: "minecraft:generic_9x3", title: "Server Selector", containerSlots: 27, totalSlots: 63, heldQuickBar: 0, heldItem: "compass", ts: 0,
      slots: [
        { slot: 11, name: "grass_block", displayName: "Grass Block", customName: "OneBlock", lore: ["Click to join OneBlock"], count: 1, section: "container" as const },
        { slot: 15, name: "iron_pickaxe", displayName: "Iron Pickaxe", customName: "Survival", lore: ["Classic survival"], count: 1, section: "container" as const },
        { slot: 40, name: "compass", displayName: "Compass", customName: null, lore: [], count: 1, section: "hotbar" as const }
      ]
    };
    assert("menu slot is found by custom name, item id and lore", findWindowSlot(menu, "oneblock")?.slot === 11 && findWindowSlot(menu, "iron pickaxe")?.slot === 15 && findWindowSlot(menu, "classic")?.slot === 15);
    assert("menu search ignores the player's own rows and unknown text", findWindowSlot(menu, "compass") === null && findWindowSlot(menu, "skyblock") === null);
    const use = guiActionInput("use_held_item", { type: "use_held_item", item: "{arg0}", hotbar: "" }, { arg0: "compass" });
    assert("automation use_held_item maps to the GUI op with {var} and a 2 s menu wait", use?.op === "use" && use.item === "compass" && use.hotbar === undefined && use.waitWindowMs === 2000, JSON.stringify(use));
    const click = guiActionInput("click_window_slot", { type: "click_window_slot", item: "OneBlock", button: "right", waitSeconds: 1.5 });
    assert("automation click_window_slot by item name", click?.op === "click" && click.item === "OneBlock" && click.slot === undefined && click.button === "right" && click.waitWindowMs === 1500, JSON.stringify(click));
    assert("automation click_window_slot by slot defaults to left and 3 s", (() => { const c = guiActionInput("click_window_slot", { type: "click_window_slot", slot: 13 }); return c?.slot === "13" && c.button === "left" && c.waitWindowMs === 3000; })());
    assert("automation GUI actions refuse missing targets", throws(() => guiActionInput("click_window_slot", { type: "click_window_slot" })) && throws(() => guiActionInput("select_hotbar_slot", { type: "select_hotbar_slot" })));
    assert("non-GUI actions are left to the rule engine", guiActionInput("send_chat", { type: "send_chat" }) === null && guiActionInput("close_window", { type: "close_window" })?.op === "close");
    assert("automation catalog lists the menu actions and the window_opened trigger", ["use_held_item", "select_hotbar_slot", "click_window_slot", "close_window"].every((type) => ACTION_META.some((m) => m.type === type && m.category === "Menu")) && TRIGGER_META.some((m) => m.type === "window_opened"));
    assert("bulk ids are de-duplicated and capped", normalizeBulkIds(["a", "a", " b "]).join(",") === "a,b" && normalizeBulkIds("a, b c").length === 3 && throws(() => normalizeBulkIds([])) && throws(() => normalizeBulkIds(Array.from({ length: 101 }, (_, i) => `id${i}`))));
    assert("bulk actions are known and the raw task action is panel-only", bulkActionType("Use-Item") === "use-item" && throws(() => bulkActionType("nuke")) && BULK_ACTIONS.every((a) => a in BULK_ACTION_CATEGORY) && BULK_ACTION_CATEGORY.task === null);
    const newer = viewerSupport("26.1");
    assert("viewer falls back to the newest textures for 26.1 instead of alerting null", newer.ok && newer.textures === "1.21.4" && newer.fallback === true && Boolean(newer.note?.includes("1.21.4")), JSON.stringify(newer));
    const unknown = viewerSupport("99.9");
    assert("viewer refuses a version it knows nothing about with a clear message", !unknown.ok && unknown.code === "viewer.version_unsupported" && unknown.message.includes("99.9") && !unknown.message.startsWith("null"), JSON.stringify(unknown));
    const mapped = viewerSupport("1.21.11");
    assert("viewer maps a newer 1.21 patch to the last 1.21 textures with a note", mapped.ok && mapped.textures === "1.21.4" && Boolean(mapped.note), JSON.stringify(mapped));
    const exact = viewerSupport("1.16.1");
    assert("viewer uses exact textures when it has them", exact.ok && exact.textures === "1.16.1" && !exact.note, JSON.stringify(exact));
    assert("viewer refuses an empty version", !viewerSupport("").ok);

    const remap = buildStateRemap("26.1", "1.21.4");
    const r26 = mcData("26.1");
    const r214 = mcData("1.21.4");
    const stairs = (data: typeof r26) => data.blocksByName.oak_stairs!;
    // oak_stairs facing=east half=top shape=straight waterlogged=false: same property order in both versions
    const offset = stairs(r26).maxStateId - stairs(r26).minStateId;
    assert("26.1 block states are translated by name and properties", Boolean(remap) && remap!.blocks[r26.blocksByName.grass_block!.defaultState] === r214.blocksByName.grass_block!.defaultState && remap!.blocks[stairs(r26).minStateId + offset] === stairs(r214).minStateId + offset);
    assert("new 26.1 blocks fall back to the closest older block", Boolean(remap) && remap!.blocks[r26.blocksByName.oak_shelf!.defaultState] === r214.blocksByName.oak_planks!.defaultState && substituteBlockName("copper_lantern", (n) => n === "lantern") === "lantern");
    const column = { toJson: () => JSON.stringify({ sections: [JSON.stringify({ data: JSON.stringify({ type: "indirect", palette: [0, r26.blocksByName.diamond_block!.defaultState] }) }), JSON.stringify({ data: JSON.stringify({ type: "single", value: r26.blocksByName.dirt!.defaultState }) })], biomes: [] }) };
    const out = JSON.parse(remapColumnJson(column, remap!));
    const first = JSON.parse(JSON.parse(out.sections[0]).data);
    const second = JSON.parse(JSON.parse(out.sections[1]).data);
    assert("chunk palettes are rewritten for the texture version", first.palette[1] === r214.blocksByName.diamond_block!.defaultState && second.value === r214.blocksByName.dirt!.defaultState, JSON.stringify([first, second]));
  }
  assert("anti-afk waits for an idle grounded bot", antiAfkAllowed({ enabled: true, taskRunning: false, onGround: true }) && !antiAfkAllowed({ enabled: true, taskRunning: true, onGround: true }));
  assert("anti-afk mode repeats one action", pickAntiAfkAction(() => 0.99, "look") === "look" && pickAntiAfkAction(() => 0.99, "mixed") === "jump");
  assert("anti-afk interval stays between 5s and 10min", clampAntiAfkInterval(1000) === 5_000 && clampAntiAfkInterval(9_000_000) === 600_000 && clampAntiAfkInterval(12_000) === 12_000);
  assert("anti-afk hold stays between 100ms and 2s", clampAntiAfkHold(10) === 100 && clampAntiAfkHold(9_000) === 2_000 && clampAntiAfkHold(750) === 750);
  assert("anti-afk lock allows chat and blocks goto", antiAfkAllowsAction("chat") && antiAfkAllowsAction("stop") && !antiAfkAllowsAction("goto"));
  assert("autostart delay stays between 0 and 300 seconds", clampAutostartDelaySec(-4) === 0 && clampAutostartDelaySec(900) === 300 && clampAutostartDelaySec(12) === 12);

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

  const ob: CommandNode[] = [
    { kind: "root", children: [1] },
    { kind: "literal", name: "ob", children: [2] },
    { kind: "literal", name: "team", children: [3, 4] },
    { kind: "literal", name: "invite", children: [5] },
    { kind: "literal", name: "accept", executable: true },
    { kind: "argument", name: "player", executable: true }
  ];
  const obFlat = flattenCommandNodes(ob);
  assert(
    "command tree keeps an argument chain on one line",
    obFlat.lines.includes("ob team accept") && obFlat.lines.includes("ob team invite <player>") && !obFlat.lines.some((line) => line.split(" ").length > 4),
    obFlat.lines.join(" | ")
  );

  const msg: CommandNode[] = [
    { kind: "root", children: [1] },
    { kind: "literal", name: "msg", children: [2] },
    { kind: "argument", name: "player", children: [3] },
    { kind: "argument", name: "message", executable: true }
  ];
  assert("nested arguments stay on one line", flattenCommandNodes(msg).lines.join(",") === "msg <player> <message>");

  const redirected: CommandNode[] = [
    { kind: "root", children: [1, 2] },
    { kind: "literal", name: "say", children: [3] },
    { kind: "literal", name: "execute", children: [4] },
    { kind: "argument", name: "message", executable: true },
    { kind: "literal", name: "run", executable: true, redirect: 0 }
  ];
  const redirectedFlat = flattenCommandNodes(redirected);
  assert(
    "a redirect is followed once and does not loop",
    redirectedFlat.lines.includes("say <message>") &&
      redirectedFlat.lines.includes("execute run") &&
      redirectedFlat.lines.includes("execute run say <message>") &&
      !redirectedFlat.lines.some((line) => line.includes("execute run execute run execute")),
    redirectedFlat.lines.join(" | ")
  );

  const cycle: CommandNode[] = [
    { kind: "root", children: [1] },
    { kind: "literal", name: "a", executable: true, children: [2] },
    { kind: "literal", name: "b", executable: true, children: [1] }
  ];
  const cycled = flattenCommandNodes(cycle);
  assert("a child cycle stops", cycled.lines.includes("a") && cycled.lines.includes("a b") && !cycled.lines.some((line) => line.split(" ").length > 4), cycled.lines.join(" | "));

  const deep: CommandNode[] = [{ kind: "root", children: [1] }];
  for (let i = 1; i <= 12; i++) deep.push({ kind: "literal", name: `n${i}`, executable: i === 12, children: i === 12 ? [] : [i + 1] });
  const deepFlat = flattenCommandNodes(deep, 0, { maxDepth: 4, maxLines: 20 });
  assert(
    "depth limit cuts a long chain",
    deepFlat.truncated && deepFlat.lines.every((line) => line.split(" ").length <= 4) && !deepFlat.lines.some((line) => line.includes("n12")),
    deepFlat.lines.join(" | ")
  );

  const wide: CommandNode[] = [{ kind: "root", children: [] }];
  for (let i = 1; i <= 30; i++) {
    wide.push({ kind: "literal", name: `c${i}`, executable: true });
    wide[0]!.children!.push(i);
  }
  const wideFlat = flattenCommandNodes(wide, 0, { maxDepth: 8, maxLines: 10 });
  assert("line limit cuts a wide tree", wideFlat.truncated && wideFlat.lines.length === 10, String(wideFlat.lines.length));

  const packet = flattenDeclarePacket({
    rootIndex: 0,
    nodes: [
      { children: [1], flags: { command_node_type: 0, has_command: 0 } },
      { children: [2], extraNodeData: { name: "msg" }, flags: { command_node_type: 1, has_command: 0 } },
      { children: [], extraNodeData: { name: "message", parser: "minecraft:message" }, flags: { command_node_type: 2, has_command: 1 } }
    ]
  });
  assert("a declare_commands packet flattens to one line", packet?.lines.join(",") === "msg <message>" && packet?.truncated === false, packet?.lines.join(" | "));
  assert("a broken command packet is ignored", flattenDeclarePacket(null) === null && flattenDeclarePacket({ nodes: "nope" }) === null);
  assert("command list defaults stay bounded", COMMAND_TREE_LIMITS.maxDepth === 8 && COMMAND_TREE_LIMITS.maxLines === 400);

  const replaced = flattenCommandNodes([{ kind: "root", children: [1] }, { kind: "literal", name: "later", executable: true }]);
  assert("a new tree replaces the previous lines", replaced.lines.join(",") === "later" && !replaced.lines.includes("ob"));
}

async function webhook(): Promise<void> {
  let calls = 0;
  let sent: { content?: string; allowed_mentions?: { parse?: string[] } } = {};
  const fakeFetch = (async (_url: unknown, init?: { body?: unknown }) => {
    calls++;
    sent = JSON.parse(String(init?.body ?? "{}"));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const hook = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789";
  const result = await postWebhook(hook, "hello @everyone", fakeFetch);
  assert("webhook test accepts a Discord URL", result.ok, result.error);
  assert("webhook body escapes mentions and disables pings", Boolean(sent.content?.includes("@\u200beveryone")) && sent.allowed_mentions?.parse?.length === 0);
  const local = await postWebhook("http://127.0.0.1:9/hook", "x", fakeFetch);
  assert("webhook refuses non-Discord URLs without a request", !local.ok && calls === 1);
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

/** Issue #34: a 26.1 world (no 26.1 textures in prismarine-viewer) still renders with 1.21.4 textures. */
async function pov26(groundY = 3) {
  const { Vec3 } = require("vec3") as typeof import("vec3");
  const Chunk = require("prismarine-chunk")("26.1");
  const reg = mcData("26.1");
  const cols = new Map<string, unknown>();
  const colAt = (cx: number, cz: number) => {
    const key = `${cx},${cz}`;
    if (cols.has(key)) return cols.get(key);
    const col = new Chunk({ minY: -64, worldHeight: 384 });
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      for (let y = groundY - 3; y < groundY; y++) col.setBlockStateId(new Vec3(x, y, z), reg.blocksByName.dirt!.defaultState);
      col.setBlockStateId(new Vec3(x, groundY, z), reg.blocksByName.grass_block!.defaultState);
    }
    // diamond wall north of the bot, mixed with a 26.1-only block (oak_shelf)
    if (cx === 0 && cz === -1) for (let y = groundY + 1; y < groundY + 5; y++) for (let x = 4; x < 12; x++) col.setBlockStateId(new Vec3(x, y, 8), reg.blocksByName[x % 2 ? "diamond_block" : "oak_shelf"]!.defaultState);
    cols.set(key, col);
    return col;
  };
  const bot = {
    version: "26.1",
    entity: { position: new Vec3(8, groundY + 1, 8), yaw: 0, pitch: -0.2 },
    world: { getColumnAt: async (p: { x: number; z: number }) => colAt(Math.floor(p.x / 16), Math.floor(p.z / 16)), raycast: () => null },
    on() {},
    removeListener() {}
  };
  const { createCanvas, loadImage } = require("canvas") as {
    createCanvas(w: number, h: number): { getContext(kind: "2d"): { drawImage(img: unknown, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } };
    loadImage(src: Buffer): Promise<{ width: number; height: number }>;
  };
  let cyan = 0;
  let detail = "";
  const shot = await renderSnapshot(bot as never, { width: 320, height: 180, viewDistance: 2 });
  if (!shot.ok) detail = `${shot.code}: ${shot.message}`;
  else {
    const img = await loadImage(Buffer.from(shot.base64, "base64"));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    cyan = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 140 && data[i + 1]! > 170 && data[i + 2]! > 160) cyan++;
    detail = `${cyan} diamond-coloured pixels`;
  }
  assert(groundY < 0 ? "blocks below y=0 render (1.18+ height, flat worlds)" : "a 26.1 world renders with 1.21.4 textures and translated blocks", cyan >= 50, detail);
}

/** Issue #34: every 26.1 block state lands on a real 1.21.4 state, and a world full of them still renders. */
async function allBlocks26() {
  const { Vec3 } = require("vec3") as typeof import("vec3");
  const Chunk = require("prismarine-chunk")("26.1");
  const src = mcData("26.1") as McBlocks & { blocksArray: { name: string; minStateId: number; maxStateId: number; defaultState: number }[] };
  const dst = mcData("1.21.4") as McBlocks & { blocksArray: { maxStateId: number }[] };
  const remap = buildStateRemap("26.1", "1.21.4");
  let maxDst = 0;
  for (const b of dst.blocksArray) maxDst = Math.max(maxDst, b.maxStateId);
  let outside = 0;
  for (const b of src.blocksArray) for (let s = b.minStateId; s <= b.maxStateId; s++) {
    const m = remap ? remap.blocks[s]! : -1;
    if (!(m >= 0 && m <= maxDst)) outside++;
  }
  assert("every 26.1 block state maps to a 1.21.4 state", Boolean(remap) && outside === 0, `${outside} unmapped`);
  const blocks = src.blocksArray.filter((b) => b.name !== "air");
  const cols = new Map<string, unknown>();
  const colAt = (cx: number, cz: number) => {
    const key = `${cx},${cz}`;
    if (cols.has(key)) return cols.get(key);
    const col = new Chunk({ minY: -64, worldHeight: 384 });
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) col.setBlockStateId(new Vec3(x, 0, z), src.blocksByName.grass_block!.defaultState);
    // her bölümde 128 farklı blok (paletli kalsın diye); komşu chunk'larda en yüksek durum id'si
    const alt = (cx + cz) & 1;
    blocks.forEach((b, i) => {
      const k = i % 128;
      col.setBlockStateId(new Vec3(((k % 64) % 8) * 2, Math.floor(i / 128) * 16 + (k < 64 ? 2 : 9), Math.floor((k % 64) / 8) * 2), alt ? b.maxStateId : b.defaultState);
    });
    cols.set(key, col);
    return col;
  };
  const bot = {
    version: "26.1",
    entity: { position: new Vec3(8, 20, 8), yaw: 0.6, pitch: -0.5 },
    world: { getColumnAt: async (p: { x: number; z: number }) => colAt(Math.floor(p.x / 16), Math.floor(p.z / 16)) },
    on() {},
    removeListener() {}
  };
  const started = Date.now();
  const shot = await renderSnapshot(bot as never, { width: 320, height: 180, viewDistance: 2 });
  assert("a 26.1 world with every block renders without crashing", shot.ok && Date.now() - started < 11_000, shot.ok ? `${Date.now() - started} ms` : `${shot.code}: ${shot.message}`);
}

function glProbe() {
  let png: Buffer;
  try {
    png = renderProbePng();
  } catch (err) {
    assert("headless probe is a PNG", false, err instanceof Error ? err.message : String(err));
    return Promise.resolve();
  }
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
  await pov26();
  await pov26(-61);
  const page = patchedPageFile("index.js");
  const pageWorker = patchedPageFile("worker.js");
  const nodeWorker = patchedNodeWorkerFile();
  const read = (f: string | null) => (f ? require("fs").readFileSync(f, "utf8") as string : "");
  assert("viewer page is patched for y<0 chunks and camera", Boolean(page) && read(page).includes("for(let i=-64;i<320;i+=16)") && !/if\(\w\.y>0&&\w&&\(\w\.target/.test(read(page)));
  assert("viewer workers are patched for y<0 sections", Boolean(pageWorker) && Boolean(nodeWorker) && read(nodeWorker).includes(".minY||0"));
  await allBlocks26();
  await glProbe();
  await webhook();
  if (failures) {
    console.log(`platform failed (${failures})`);
    process.exit(1);
  }
  console.log("platform passed");
})();

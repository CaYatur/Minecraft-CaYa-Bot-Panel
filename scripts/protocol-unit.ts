/**
 * Movement packet compatibility (server/src/core/protocolCompat.ts). No Minecraft server.
 * The live check against Paper + ViaVersion + GrimAC is described in test-server/README.md.
 */
import { EventEmitter } from "events";
import { Vec3 } from "vec3";
import { compatInfoFor, installProtocolCompat } from "../server/src/core/protocolCompat";

let failures = 0;
const ok = (name: string) => console.log(`  ok ${name}`);
const fail = (name: string, detail?: string) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};
const assert = (name: string, cond: boolean, detail?: string) => (cond ? ok(name) : fail(name, detail));

type Sent = { name: string; params: Record<string, unknown> };
const HOOK = Symbol.for("caya.protocolCompat");

function fakeBot(version: string) {
  const sent: Sent[] = [];
  const client = new EventEmitter() as EventEmitter & { write: (n: string, p: Record<string, unknown>) => void; state: string };
  client.state = "play";
  client.write = (name, params) => {
    sent.push({ name, params });
  };
  const bot = new EventEmitter() as EventEmitter & Record<string, unknown> & Record<symbol, unknown>;
  bot._client = client;
  bot.version = version;
  bot.entity = { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, isCollidedHorizontally: false };
  const handle = installProtocolCompat(bot as never);
  bot.emit("login");
  const tick = (state: Record<string, unknown>) => (bot[HOOK] as { onTick(s: unknown): void }).onTick(state);
  return { bot, client, sent, handle, tick };
}

const control = (patch: Record<string, boolean> = {}) => ({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  sneak: false,
  ...patch
});
const flush = () => new Promise<void>((r) => setImmediate(r));

async function main() {
  console.log("— protocol compat unit —\n");

  const v26 = compatInfoFor("26.1");
  assert("26.1 sends tick_end and the full input packet", v26.tickEnd && v26.fullInput);
  assert(
    "26.1 entity_action uses the renumbered names",
    Boolean(v26.entityActionNames?.has("start_sprinting")) && !v26.entityActionNames?.has("start_sneaking")
  );
  assert(
    "26.1 movement speed attribute is re-keyed from the shifted name",
    v26.attributeFix?.get("generic.scale") === "minecraft:movement_speed",
    String(v26.attributeFix?.get("generic.scale"))
  );
  const v1214 = compatInfoFor("1.21.4");
  assert("1.21.4 keeps the old entity_action numbers", v1214.tickEnd && v1214.entityActionNames === null);
  const v1204 = compatInfoFor("1.20.4");
  assert("1.20.4 needs no tick_end, input or attribute fix", !v1204.tickEnd && !v1204.fullInput && v1204.attributeFix === null);

  // packet order inside one tick: input → movement → tick_end
  {
    const { client, sent, tick } = fakeBot("26.1");
    tick({ control: control({ forward: true, sprint: true }), yaw: Math.PI / 2, pitch: 0, onGround: true, isCollidedHorizontally: false });
    client.write("position", { x: 0, y: 64, z: 1, onGround: true, flags: { onGround: true } });
    await flush();
    const names = sent.map((s) => s.name).join(",");
    assert("tick order is player_input, position_look, tick_end", names === "player_input,position_look,tick_end", names);
    const input = sent[0]?.params.inputs as Record<string, boolean>;
    assert("player_input carries forward and sprint", input?.forward === true && input?.sprint === true && input?.jump === false);
    assert("the movement packet carries the simulated yaw", sent[1]?.params.yaw === Math.fround(90), String(sent[1]?.params.yaw));

    sent.length = 0;
    tick({ control: control({ forward: true, sprint: true }), yaw: Math.PI / 2, pitch: 0, onGround: true, isCollidedHorizontally: false });
    client.write("position_look", { x: 0, y: 64, z: 2, yaw: 77, pitch: 0, onGround: true, flags: { onGround: true } });
    await flush();
    const names2 = sent.map((s) => s.name).join(",");
    assert("unchanged keys and yaw: no input packet, plain position", names2 === "position,tick_end", names2);

    sent.length = 0;
    tick({ control: control(), yaw: Math.PI / 2 + 2 * Math.PI, pitch: 0, onGround: true, isCollidedHorizontally: false });
    await flush();
    const look = sent.find((s) => s.name === "look");
    assert("a full extra turn is not sent as a 360° jump", !look, JSON.stringify(sent.map((s) => s.name)));
  }

  // entity_action: renumbered ids, sprint deferred to the next tick
  {
    const { client, sent, tick } = fakeBot("26.1");
    client.write("entity_action", { entityId: 1, actionId: 3, jumpBoost: 0 });
    assert("start sprinting (legacy 3) goes out by name", sent[0]?.params.actionId === "start_sprinting", JSON.stringify(sent[0]));
    sent.length = 0;
    client.write("entity_action", { entityId: 1, actionId: 0, jumpBoost: 0 });
    client.write("player_input", { inputs: { shift: true } });
    assert("legacy sneak action and partial player_input are dropped", sent.length === 0, JSON.stringify(sent));

    tick({ control: control({ forward: true }), yaw: 0, pitch: 0, onGround: true, isCollidedHorizontally: false });
    client.write("entity_action", { entityId: 1, actionId: 4, jumpBoost: 0 });
    await flush();
    assert("a mid-tick sprint stop waits for the next tick", !sent.some((s) => s.name === "entity_action"));
    sent.length = 0;
    tick({ control: control({ forward: true }), yaw: 0, pitch: 0, onGround: true, isCollidedHorizontally: false });
    assert(
      "the deferred sprint stop goes first in the next tick",
      sent[0]?.name === "entity_action" && sent[0]?.params.actionId === "stop_sprinting",
      JSON.stringify(sent.map((s) => s.name))
    );
  }

  // older version keeps numbers and sends no tick_end
  {
    const { client, sent, tick } = fakeBot("1.20.4");
    tick({ control: control({ forward: true }), yaw: 0, pitch: 0, onGround: true, isCollidedHorizontally: false });
    client.write("entity_action", { entityId: 1, actionId: 3, jumpBoost: 0 });
    await flush();
    assert("1.20.4: no tick_end or player_input", !sent.some((s) => s.name === "tick_end" || s.name === "player_input"));
    assert("1.20.4: entity_action number untouched", sent.find((s) => s.name === "entity_action")?.params.actionId === 3);
    sent.length = 0;
    tick({ control: control({ forward: true }), yaw: Math.PI / 2, pitch: 0, onGround: true, isCollidedHorizontally: false });
    client.write("position_look", { x: 0, y: 64, z: 1, yaw: 12, pitch: 0, onGround: true });
    await flush();
    assert(
      "1.20.4: movement packets keep mineflayer's yaw",
      sent.length === 1 && sent[0]?.name === "position_look" && sent[0]?.params.yaw === 12,
      JSON.stringify(sent)
    );
  }

  // attributes and teleport velocity
  {
    const { bot, client } = fakeBot("26.1");
    const pkt = { entityId: 1, properties: [{ key: "generic.scale", value: 0.1, modifiers: [{ id: "minecraft:sprinting", amount: 0.3, operation: 2 }] }] };
    client.emit("entity_update_attributes", pkt);
    assert(
      "movement speed arrives under the key the physics reads, without the sprint modifier",
      pkt.properties[0]!.key === "minecraft:movement_speed" && pkt.properties[0]!.modifiers.length === 0,
      JSON.stringify(pkt.properties[0])
    );

    const ent = bot.entity as { velocity: Vec3 };
    ent.velocity = new Vec3(0.2, 0, 0.2);
    const flags = { x: false, y: false, z: false, yaw: false, pitch: false, dx: false, dy: false, dz: false, yawDelta: false };
    client.emit("position", { teleportId: 1, x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags });
    assert("an absolute setback clears velocity", ent.velocity.x === 0 && ent.velocity.z === 0, ent.velocity.toString());
    ent.velocity = new Vec3(0.2, 0, 0);
    client.emit("position", { teleportId: 2, x: 0, y: 64, z: 0, dx: 0.1, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: { ...flags, dx: true } });
    assert("a relative teleport velocity is added", Math.abs(ent.velocity.x - 0.3) < 1e-9, ent.velocity.toString());
  }

  // escape hatch
  {
    process.env.CAYA_PROTOCOL_COMPAT = "off";
    const { client, sent } = fakeBot("26.1");
    client.write("entity_action", { entityId: 1, actionId: 3, jumpBoost: 0 });
    assert("CAYA_PROTOCOL_COMPAT=off leaves packets alone", sent[0]?.params.actionId === 3);
    delete process.env.CAYA_PROTOCOL_COMPAT;
  }

  console.log(failures ? `\nprotocol FAILED (${failures})` : "\nprotocol passed");
  process.exit(failures ? 1 : 0);
}

void main();

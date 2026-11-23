import type { Bot } from "mineflayer";

/**
 * Movement packet fixes for mineflayer on 1.21.2+ servers (issue #34).
 *
 * Vanilla servers accept the packets mineflayer 4.39 sends, but anti-cheats that
 * re-simulate movement (Grim, Vulcan, Polar…) pull the bot back on every step:
 *
 * 1. `tick_end` (1.21.2+) is never sent, so the server cannot count client ticks.
 * 2. `player_input` (1.21.3+) carries the movement keys, but mineflayer only sends
 *    it for sneak, so the server sees a player that moves with no key pressed.
 * 3. The physics turns the body to the new yaw at once, but the packet yaw only
 *    turns ~8.6° per tick: the bot says "facing north" while walking east.
 * 4. `entity_action` ids were renumbered in 1.21.6; mineflayer still sends the old
 *    numbers, so "start sprinting" (3) arrives as "start riding jump".
 * 5. Sprint toggles made after a tick's simulation went out before that tick's
 *    position, so the server applied them one tick early.
 * 6. 1.21.2+ teleports carry a velocity of their own, which mineflayer ignores.
 * 7. 1.21+ attribute ids are decoded with a shifted name table (movement speed
 *    arrives as "scale"), so speed effects never reached the physics.
 *
 * Every packet below describes exactly the state the physics simulated in that
 * tick, in vanilla order: input → movement → tick_end.
 */

type Params = Record<string, unknown>;
type Write = (name: string, params: Params) => void;
type ControlLike = Record<"forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak", boolean>;

interface SimState {
  control: ControlLike;
  yaw: number;
  pitch: number;
  onGround: boolean;
  isCollidedHorizontally: boolean;
}

interface CompatHooks {
  onTick(state: SimState): void;
}

const HOOK = Symbol.for("caya.protocolCompat");
const MOVE_PACKETS = new Set(["position", "position_look", "look", "flying"]);
/** entity_action ids as mineflayer still numbers them (pre-1.21.6). */
const LEGACY_ENTITY_ACTIONS = [
  "start_sneaking",
  "stop_sneaking",
  "stop_sleeping",
  "start_sprinting",
  "stop_sprinting",
  "start_riding_jump",
  "stop_riding_jump",
  "open_inventory",
  "start_fall_flying"
];

function req<T>(id: string): T {
  // mineflayer resolves its own copies; use the same ones.
  const from = require.resolve("mineflayer");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(require.resolve(id, { paths: [from] })) as T;
}

let applyPatched = false;
/** The only call of PlayerState.apply is mineflayer's real physics tick (pathfinder simulates without applying). */
function patchPlayerStateApply() {
  if (applyPatched) return;
  applyPatched = true;
  const { PlayerState } = req<{ PlayerState: { prototype: { apply(bot: unknown): void } } }>("prismarine-physics");
  const orig = PlayerState.prototype.apply;
  PlayerState.prototype.apply = function (this: SimState, bot: unknown) {
    orig.call(this, bot);
    const hooks = (bot as Record<symbol, CompatHooks | undefined> | null)?.[HOOK];
    if (hooks) {
      try {
        hooks.onTick(this);
      } catch {
        /* never break the physics loop */
      }
    }
  };
}

/** Notchian degrees, exactly as mineflayer converts them. */
const toNotchianYaw = (yaw: number) => ((Math.PI - yaw) * 180) / Math.PI;
const toNotchianPitch = (pitch: number) => (-pitch * 180) / Math.PI;

interface ProtocolTypes {
  play: { toServer: { types: Record<string, unknown> }; toClient: { types: Record<string, unknown> } };
}

function mapperNames(type: unknown): Record<string, string> | null {
  const m = JSON.stringify(type ?? null).match(/"mappings":(\{[^}]*\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as Record<string, string>;
  } catch {
    return null;
  }
}

export interface CompatInfo {
  tickEnd: boolean;
  fullInput: boolean;
  entityActionNames: Set<string> | null;
  attributeFix: Map<string, string> | null;
}

/** What this version needs. Exported for unit tests. */
export function compatInfoFor(version: string): CompatInfo {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mcData = require("minecraft-data")(version) as {
    protocol?: ProtocolTypes;
    attributesArray?: Array<{ resource: string }>;
    supportFeature(name: string): boolean;
    version: { ">="(v: string): boolean };
  } | null;
  if (!mcData) return { tickEnd: false, fullInput: false, entityActionNames: null, attributeFix: null };
  const tickEnd = mcData.supportFeature("sendsClientTickEndPacket");
  const fullInput = mcData.supportFeature("newPlayerInputPacket");

  let entityActionNames: Set<string> | null = null;
  const actions = mapperNames(mcData.protocol?.play.toServer.types.packet_entity_action);
  if (actions) {
    const names = Object.values(actions);
    if (!names.includes("start_sneaking")) entityActionNames = new Set(names);
  }

  // attribute ids: the protocol name table vs the registry (registry order is the wire order)
  let attributeFix: Map<string, string> | null = null;
  const wire = mapperNames(mcData.protocol?.play.toClient.types.packet_entity_update_attributes);
  const registry = mcData.attributesArray;
  // Checked on real servers for 1.21.5+ (movement speed arrived as "scale"); older 1.21.x unverified.
  if (wire && registry?.length && mcData.version[">="]("1.21.5")) {
    attributeFix = new Map();
    for (const [id, wrongName] of Object.entries(wire)) {
      const right = registry[Number(id)]?.resource;
      if (right) attributeFix.set(wrongName, right);
    }
    for (let i = Object.keys(wire).length; i < registry.length; i++) {
      // ids past the protocol table arrive as raw numbers
      attributeFix.set(String(i), registry[i]!.resource);
    }
  }
  return { tickEnd, fullInput, entityActionNames, attributeFix };
}

export interface ProtocolCompatHandle {
  info: CompatInfo | null;
  stats: { setbacks: number; lastSetbackAt: number };
}

/** Install right after createBot(); safe on every version (no-ops where not needed). */
export function installProtocolCompat(bot: Bot): ProtocolCompatHandle {
  const handle: ProtocolCompatHandle = { info: null, stats: { setbacks: 0, lastSetbackAt: 0 } };
  const client = (bot as unknown as { _client: { write: Write; state: string; on: Function; prependListener: Function } })._client;
  if (!client || typeof client.write !== "function") return handle;
  if (/^(0|off|false)$/i.test(process.env.CAYA_PROTOCOL_COMPAT ?? "")) return handle; // escape hatch
  patchPlayerStateApply();

  const rawWrite: Write = client.write.bind(client);
  let info: CompatInfo | null = null;
  let own = false;
  let inTick = false;
  let sim: { yaw: number; pitch: number; onGround: boolean; hcol: boolean } | null = null;
  let sentYaw: number | null = null;
  let sentPitch: number | null = null;
  let lastInput = "";
  const deferred: Array<[string, Params]> = [];

  const writeOwn = (name: string, params: Params) => {
    own = true;
    try {
      rawWrite(name, params);
    } finally {
      own = false;
    }
  };
  const playing = () => client.state === "play";

  const endTick = () => {
    if (!inTick) return;
    inTick = false;
    if (!info || !sim || !playing()) return;
    if (sentYaw !== sim.yaw || sentPitch !== sim.pitch) {
      writeOwn("look", {
        yaw: sim.yaw,
        pitch: sim.pitch,
        onGround: sim.onGround,
        flags: { onGround: sim.onGround, hasHorizontalCollision: sim.hcol }
      });
      sentYaw = sim.yaw;
      sentPitch = sim.pitch;
    }
    if (info.tickEnd) writeOwn("tick_end", {});
  };

  client.write = (name: string, params: Params) => {
    if (own || !info) return rawWrite(name, params);
    if (info.fullInput && name === "player_input") return; // the full key state goes out each tick instead
    if (name === "entity_action" && params && typeof params.actionId === "number" && info.entityActionNames) {
      const legacy = LEGACY_ENTITY_ACTIONS[params.actionId];
      if (!legacy || !info.entityActionNames.has(legacy)) return; // sneak lives in player_input now
      params = { ...params, actionId: legacy };
    }
    if (name === "entity_action" && inTick && /sprint/.test(String(params?.actionId))) {
      deferred.push([name, params]); // belongs to the next simulated tick
      return;
    }
    if (MOVE_PACKETS.has(name) && params) {
      if (inTick && sim) {
        if (sentYaw !== sim.yaw || sentPitch !== sim.pitch) {
          if (name === "position") name = "position_look";
          else if (name === "flying") name = "look";
          params = { ...params, yaw: sim.yaw, pitch: sim.pitch };
          sentYaw = sim.yaw;
          sentPitch = sim.pitch;
        } else if (name === "position_look") {
          name = "position";
        } else if (name === "look") {
          name = "flying";
        }
      } else if (typeof params.yaw === "number") {
        // teleport confirmation and other out-of-tick packets
        sentYaw = params.yaw as number;
        sentPitch = params.pitch as number;
      }
      if (info.tickEnd && params.flags && typeof params.flags === "object") {
        const entity = bot.entity as unknown as { isCollidedHorizontally?: boolean } | undefined;
        params = {
          ...params,
          flags: {
            onGround: Boolean((params.flags as Params).onGround),
            hasHorizontalCollision: inTick && sim ? sim.hcol : Boolean(entity?.isCollidedHorizontally)
          }
        };
      }
    }
    return rawWrite(name, params);
  };

  const hooks: CompatHooks = {
    onTick(state) {
      endTick(); // catch-up loop: the previous tick closes first
      if (!info || !playing()) return;
      while (deferred.length) {
        const [n, p] = deferred.shift()!;
        writeOwn(n, p);
      }
      if (info.fullInput) {
        const c = state.control;
        const inputs = {
          forward: !!c.forward,
          backward: !!c.back,
          left: !!c.left,
          right: !!c.right,
          jump: !!c.jump,
          shift: !!c.sneak,
          sprint: !!c.sprint
        };
        const key = JSON.stringify(inputs);
        if (key !== lastInput) {
          lastInput = key;
          writeOwn("player_input", { inputs });
        }
      }
      // vanilla yaw is continuous: never jump a full turn against what the server last saw
      let yawDeg = toNotchianYaw(state.yaw);
      if (sentYaw !== null) yawDeg -= Math.round((yawDeg - sentYaw) / 360) * 360;
      sim = {
        yaw: Math.fround(yawDeg),
        pitch: Math.fround(toNotchianPitch(state.pitch)),
        onGround: !!state.onGround,
        hcol: !!state.isCollidedHorizontally
      };
      inTick = true;
      queueMicrotask(endTick);
    }
  };

  // clientbound teleport (setback): 1.21.2+ carries velocity + its own relative flags
  let before: { vx: number; vy: number; vz: number; yaw: number } | null = null;
  client.prependListener("position", () => {
    const e = bot.entity;
    before = e ? { vx: e.velocity.x, vy: e.velocity.y, vz: e.velocity.z, yaw: e.yaw } : null;
  });
  client.on("position", (p: Params) => {
    handle.stats.setbacks++;
    handle.stats.lastSetbackAt = Date.now();
    inTick = false; // the confirm went out mid-cycle; next tick starts clean
    const f = p.flags as Record<string, boolean> | undefined;
    if (!before || !bot.entity || typeof p.dx !== "number" || !f || typeof f !== "object") return;
    let vx = before.vx;
    let vz = before.vz;
    if (f.yawDelta) {
      const d = -(bot.entity.yaw - before.yaw);
      const c = Math.cos(d);
      const s = Math.sin(d);
      const nx = vx * c - vz * s;
      vz = vx * s + vz * c;
      vx = nx;
    }
    bot.entity.velocity.set(
      f.dx ? vx + (p.dx as number) : (p.dx as number),
      f.dy ? before.vy + (p.dy as number) : (p.dy as number),
      f.dz ? vz + (p.dz as number) : (p.dz as number)
    );
  });

  // attribute names: re-key with the registry name the physics looks up
  const fixAttributes = (packet: { properties?: Array<{ key: string; modifiers?: Array<Record<string, unknown>> }> }) => {
    const fix = info?.attributeFix;
    if (!fix || !Array.isArray(packet?.properties)) return;
    for (const prop of packet.properties) {
      const right = fix.get(String(prop.key));
      if (!right) continue;
      prop.key = right;
      if (right === "minecraft:movement_speed" && Array.isArray(prop.modifiers)) {
        // the physics adds its own client-side sprint boost
        prop.modifiers = prop.modifiers.filter((m) => !/sprint/i.test(String(m.uuid ?? m.id ?? "")));
      }
    }
  };
  client.prependListener("entity_update_attributes", fixAttributes);

  bot.once("login", () => {
    try {
      info = compatInfoFor(bot.version);
    } catch {
      info = null;
    }
    handle.info = info;
    (bot as unknown as Record<symbol, CompatHooks>)[HOOK] = hooks;
  });
  bot.once("end", () => {
    delete (bot as unknown as Record<symbol, CompatHooks | undefined>)[HOOK];
  });
  return handle;
}

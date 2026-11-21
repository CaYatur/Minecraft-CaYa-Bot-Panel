import { createRequire } from "module";

const nodeRequire = createRequire(__filename);

/**
 * Issue #34 — prismarine-viewer'ın doku/blok-durumu dosyası olmayan sürümler (26.1 gibi)
 * en yeni desteklenen sürümün (1.21.4) dokularıyla çizilir. Blok durum id'leri sürümler
 * arasında kaydığı için (26.1 ile 1.21.4 arasında blokların ~%90'ı) chunk'lar görüntüleyiciye
 * gitmeden önce isim + özelliklere göre hedef sürümün id'lerine çevrilir. Hedefte olmayan
 * yeni bloklar en yakın eski bloğa (raf → kalas, bakır fener → fener) ya da düz taşa düşer.
 */

interface StateDef {
  name: string;
  type: string;
  num_values: number;
  values?: string[];
}
interface BlockDef {
  id: number;
  name: string;
  minStateId: number;
  maxStateId: number;
  defaultState: number;
  boundingBox?: string;
  states?: StateDef[];
}
interface McData {
  blocksArray: BlockDef[];
  blocksByName: Record<string, BlockDef>;
  biomesArray?: Array<{ id: number; name: string }>;
  biomesByName?: Record<string, { id: number; name: string }>;
}

export interface StateRemap {
  from: string;
  to: string;
  blocks: Int32Array;
  biomes: Int32Array;
  /** hedefte aynı isimle bulunamayıp yakın bloğa düşen blok adları */
  substituted: number;
}

const cache = new Map<string, StateRemap | null>();

/** Hedef sürümde olmayan yeni bloklar için en yakın eski blok */
export function substituteBlockName(name: string, has: (n: string) => boolean): string | null {
  const tries: string[] = [];
  const unwax = name.replace(/^waxed_/, "").replace(/^(exposed|weathered|oxidized)_/, "");
  if (name.endsWith("_shelf")) tries.push(name.replace(/_shelf$/, "_planks"), name.replace(/_shelf$/, "_hyphae"), name.replace(/_shelf$/, "_stem"), "oak_planks");
  if (/copper_bars$/.test(name)) tries.push("iron_bars");
  if (/(^|_)chain$/.test(name)) tries.push("chain", "iron_chain");
  if (/copper_lantern$/.test(name)) tries.push("lantern");
  if (/copper_chest$/.test(name)) tries.push("chest");
  if (/copper_golem_statue$/.test(name)) tries.push(unwax.replace(/copper_golem_statue$/, "copper_block"), "copper_block");
  if (/lightning_rod$/.test(name)) tries.push("lightning_rod");
  if (name === "copper_wall_torch") tries.push("wall_torch");
  if (name === "copper_torch") tries.push("torch");
  if (name === "golden_dandelion") tries.push("dandelion");
  if (name === "potted_golden_dandelion") tries.push("potted_dandelion");
  if (name === "bush" || name === "short_dry_grass" || name === "firefly_bush") tries.push("short_grass", "grass", "dead_bush");
  if (name === "tall_dry_grass") tries.push("tall_grass", "dead_bush");
  if (name === "cactus_flower") tries.push("poppy");
  if (name === "wildflowers" || name === "leaf_litter") tries.push("pink_petals");
  if (name === "dried_ghast") tries.push("skeleton_skull");
  if (name.startsWith("test_")) tries.push("structure_block");
  if (unwax !== name) tries.push(unwax);
  for (const t of tries) if (has(t)) return t;
  return null;
}

function decode(block: BlockDef, stateId: number): Array<{ def: StateDef; index: number }> {
  const states = block.states ?? [];
  let data = stateId - block.minStateId;
  const out: Array<{ def: StateDef; index: number }> = new Array(states.length);
  for (let i = states.length - 1; i >= 0; i--) {
    const def = states[i]!;
    const n = Math.max(1, def.num_values);
    out[i] = { def, index: data % n };
    data = Math.floor(data / n);
  }
  return out;
}

function encode(target: BlockDef, props: Array<{ def: StateDef; index: number }>): number {
  const states = target.states ?? [];
  if (!states.length) return target.defaultState;
  const defaults = decode(target, target.defaultState);
  let data = 0;
  for (let i = 0; i < states.length; i++) {
    const def = states[i]!;
    const n = Math.max(1, def.num_values);
    let index = defaults[i]!.index;
    const src = props.find((p) => p.def.name === def.name);
    if (src) {
      if (def.values && src.def.values) {
        const value = src.def.values[src.index];
        const at = value === undefined ? -1 : def.values.indexOf(value);
        if (at >= 0) index = at;
      } else if (src.index < n) {
        index = src.index;
      }
    }
    data = data * n + index;
  }
  return target.minStateId + data;
}

/** fromVersion durum id'lerini toVersion'a çeviren tablo; iki sürüm aynıysa ya da veri yoksa null */
export function buildStateRemap(fromVersion: string, toVersion: string): StateRemap | null {
  if (!fromVersion || !toVersion || fromVersion === toVersion) return null;
  const key = `${fromVersion}->${toVersion}`;
  if (cache.has(key)) return cache.get(key)!;
  let result: StateRemap | null = null;
  try {
    const mcData = nodeRequire("minecraft-data") as (v: string) => McData | undefined;
    const src = mcData(fromVersion);
    const dst = mcData(toVersion);
    if (src?.blocksArray && dst?.blocksArray) {
      let maxState = 0;
      for (const b of src.blocksArray) maxState = Math.max(maxState, b.maxStateId);
      const blocks = new Int32Array(maxState + 1);
      const stone = dst.blocksByName.stone?.defaultState ?? 1;
      const air = dst.blocksByName.air?.defaultState ?? 0;
      const has = (n: string) => Boolean(dst.blocksByName[n]);
      let substituted = 0;
      for (const b of src.blocksArray) {
        let target: BlockDef | undefined = dst.blocksByName[b.name];
        if (!target) {
          const alt = substituteBlockName(b.name, has);
          target = alt ? dst.blocksByName[alt] : undefined;
          substituted++;
        }
        for (let s = b.minStateId; s <= b.maxStateId; s++) {
          if (!target) blocks[s] = b.boundingBox === "block" ? stone : air;
          else blocks[s] = encode(target, decode(b, s));
        }
      }
      let maxBiome = 0;
      for (const bi of src.biomesArray ?? []) maxBiome = Math.max(maxBiome, bi.id);
      const biomes = new Int32Array(maxBiome + 1);
      const plains = dst.biomesByName?.plains?.id ?? 0;
      for (const bi of src.biomesArray ?? []) biomes[bi.id] = dst.biomesByName?.[bi.name]?.id ?? plains;
      result = { from: fromVersion, to: toVersion, blocks, biomes, substituted };
    }
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}

export function mapState(remap: StateRemap, stateId: number): number {
  return stateId >= 0 && stateId < remap.blocks.length ? remap.blocks[stateId]! : stateId;
}

interface ColumnLike {
  toJson(): string;
}

type Json = Record<string, unknown>;

/**
 * Paletteli kap JSON'u: { type: "single", value } | { type: "indirect", palette } | { type: "direct", data }.
 * "direct" kaplar (bir bölümde 256'dan fazla farklı durum) prismarine-chunk'ın JSON
 * gidiş-dönüşünde zaten kayboluyor (BitArray.fromJson longları okuyamıyor); onlara dokunulmaz.
 */
function remapContainerJson(raw: unknown, table: Int32Array): unknown {
  if (typeof raw !== "string") return raw;
  const container = JSON.parse(raw) as Json;
  const map = (v: unknown) => (typeof v === "number" && v >= 0 && v < table.length ? table[v]! : v);
  if (container.type === "single") container.value = map(container.value);
  else if (container.type === "indirect" && Array.isArray(container.palette)) container.palette = container.palette.map(map);
  return JSON.stringify(container);
}

function remapSectionJson(raw: unknown, table: Int32Array): unknown {
  if (typeof raw !== "string") return raw;
  const section = JSON.parse(raw) as Json;
  section.data = remapContainerJson(section.data, table);
  // bölüm düzeyindeki palette, kabın palette'inin kopyası
  if (Array.isArray(section.palette)) section.palette = section.palette.map((v) => (typeof v === "number" && v >= 0 && v < table.length ? table[v]! : v));
  return JSON.stringify(section);
}

/** Bir chunk sütununun JSON'unu hedef sürümün durum id'leriyle üretir (kaynak sütun değişmez). */
export function remapColumnJson(column: ColumnLike, remap: StateRemap): string {
  const json = column.toJson();
  try {
    const parsed = JSON.parse(json) as Json;
    if (!Array.isArray(parsed.sections)) return json; // 1.18 öncesi biçim: çevrilmez
    parsed.sections = parsed.sections.map((s) => remapSectionJson(s, remap.blocks));
    if (Array.isArray(parsed.biomes)) parsed.biomes = parsed.biomes.map((b) => remapSectionJson(b, remap.biomes));
    return JSON.stringify(parsed);
  } catch {
    return json;
  }
}

interface WorldLike {
  getColumnAt(pos: unknown): Promise<ColumnLike | null | undefined> | ColumnLike | null | undefined;
}

/** WorldView'in gördüğü dünya: getColumnAt sütunu çevrilmiş JSON ile döndürür, gerisi aynı */
export function remappedWorld<T extends object>(world: T, remap: StateRemap): T {
  return new Proxy(world, {
    get(target, prop, receiver) {
      if (prop === "getColumnAt") {
        return async (pos: unknown) => {
          const column = await (target as unknown as WorldLike).getColumnAt(pos);
          if (!column) return column;
          return { toJson: () => remapColumnJson(column, remap) };
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

type Listener = (...args: unknown[]) => void;

/**
 * prismarine-viewer'a verilen bot: version = doku sürümü, world = çevrilmiş dünya,
 * blockUpdate olayları çevrilmiş durum id'si taşır. Atamalar (bot.viewer) gerçek bota gider.
 */
export function viewerBot<T extends object>(bot: T, textures: string, remap: StateRemap | null): T {
  const wrapped = new WeakMap<Listener, Listener>();
  const wrap = (event: unknown, fn: Listener): Listener => {
    if (event !== "blockUpdate" || !remap) return fn;
    let w = wrapped.get(fn);
    if (!w) {
      w = (oldBlock: unknown, newBlock: unknown) => {
        const nb = newBlock as { stateId?: number; position?: unknown; name?: string } | null;
        // WorldView yalnızca stateId'yi (0 ise type/metadata'yı) okur
        if (nb && typeof nb.stateId === "number") fn(oldBlock, { stateId: mapState(remap, nb.stateId), type: 0, metadata: 0, position: nb.position, name: nb.name });
        else fn(oldBlock, newBlock);
      };
      wrapped.set(fn, w);
    }
    return w;
  };
  const world = remap ? remappedWorld((bot as unknown as { world: object }).world, remap) : (bot as unknown as { world: object }).world;
  return new Proxy(bot, {
    get(target, prop, receiver) {
      if (prop === "version") return textures;
      if (prop === "world") return world;
      if (prop === "on" || prop === "addListener" || prop === "once" || prop === "removeListener" || prop === "off") {
        const fn = Reflect.get(target, prop, receiver) as (event: unknown, l: Listener) => unknown;
        return (event: unknown, listener: Listener) => {
          fn.call(target, event, wrap(event, listener));
          return receiver;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    }
  });
}

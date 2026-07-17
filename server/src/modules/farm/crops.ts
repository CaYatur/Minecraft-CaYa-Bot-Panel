import type { Block } from "prismarine-block";

/** Faz 19 tarım sabitleri — ekin/tohum eşlemesi ve olgunluk kuralları. */

/** çapayla farmland'e dönüşebilen bloklar */
export const TILLABLE = new Set(["dirt", "grass_block", "dirt_path", "coarse_dirt", "rooted_dirt"]);

/** çapa tercihi (dayanıklıdan ucuza) */
export const HOE_ORDER = [
  "netherite_hoe",
  "diamond_hoe",
  "iron_hoe",
  "golden_hoe",
  "stone_hoe",
  "wooden_hoe"
] as const;

export interface CropDef {
  /** ekin bloğu adı (dünyada) */
  block: string;
  /** ekilen item */
  seed: string;
  /** olgun yaş (age property) */
  matureAge: number;
  /** ana ürünler (depolamada toplanacaklar) */
  produce: string[];
}

/** ekin bloğu adı → tanım */
export const CROPS: Record<string, CropDef> = {
  wheat: { block: "wheat", seed: "wheat_seeds", matureAge: 7, produce: ["wheat", "wheat_seeds"] },
  carrots: { block: "carrots", seed: "carrot", matureAge: 7, produce: ["carrot"] },
  potatoes: { block: "potatoes", seed: "potato", matureAge: 7, produce: ["potato", "poisonous_potato"] },
  beetroots: { block: "beetroots", seed: "beetroot_seeds", matureAge: 3, produce: ["beetroot", "beetroot_seeds"] },
  melon_stem: { block: "melon_stem", seed: "melon_seeds", matureAge: 7, produce: ["melon_slice"] },
  pumpkin_stem: { block: "pumpkin_stem", seed: "pumpkin_seeds", matureAge: 7, produce: ["pumpkin"] }
};

/** tohum/ekin kullanıcı girdisi → tohum item adı (esnek: "wheat", "carrots", "buğday" değil) */
export function seedForCrop(input: string): string {
  const n = input.trim().toLowerCase().replace(/^minecraft:/, "");
  if (!n) return "wheat_seeds";
  for (const def of Object.values(CROPS)) {
    if (def.seed === n || def.block === n) return def.seed;
  }
  // yaygın kısaltmalar
  if (n === "wheat" || n === "seeds") return "wheat_seeds";
  if (n === "carrot" || n === "carrots") return "carrot";
  if (n === "potato" || n === "potatoes") return "potato";
  if (n === "beetroot" || n === "beetroots") return "beetroot_seeds";
  if (n === "melon") return "melon_seeds";
  if (n === "pumpkin") return "pumpkin_seeds";
  return "wheat_seeds";
}

/** hasat edilen ekin bloğu → yeniden ekilecek tohum */
export function cropForSeed(cropBlock: string): string | null {
  const def = CROPS[cropBlock];
  if (def) return def.seed;
  if (cropBlock === "melon" || cropBlock === "pumpkin") return null; // gövde durur, meyve tekrar büyür
  return null;
}

/** depoya kaldırılacak tarım ürünleri (tohumlar dahil — keepCounts ekim payı ayırır) */
export const FARM_PRODUCE = new Set<string>([
  "wheat",
  "wheat_seeds",
  "carrot",
  "potato",
  "poisonous_potato",
  "beetroot",
  "beetroot_seeds",
  "melon_slice",
  "melon_seeds",
  "pumpkin",
  "pumpkin_seeds"
]);

/** blok olgun ekin mi (melon/pumpkin MEYVESİ hasat edilir; sapları asla — meyveyi sap büyütür) */
export function isMatureCrop(block: Block): boolean {
  if (block.name === "melon" || block.name === "pumpkin") return true;
  if (block.name.endsWith("_stem")) return false;
  const def = CROPS[block.name];
  if (!def) return false;
  try {
    const props = block.getProperties() as { age?: number | string };
    const age = props?.age != null ? Number(props.age) : NaN;
    return Number.isFinite(age) && age >= def.matureAge;
  } catch {
    return false;
  }
}

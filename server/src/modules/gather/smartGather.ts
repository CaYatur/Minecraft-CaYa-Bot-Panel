import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import type { ProgressFn, TaskToken } from "../../core/TaskQueue";
import type { CountMode } from "./index";
import { runGoto } from "../movement";
import { ringSearch } from "./ringSearch";

interface DropEntityLike {
  id: number;
  name?: string;
  position: Bot["entity"]["position"];
  getDroppedItem?: () => { name?: string } | null;
}

const WOOD_TO_PLANKS: Record<string, string> = {
  oak_planks: "oak_log",
  spruce_planks: "spruce_log",
  birch_planks: "birch_log",
  jungle_planks: "jungle_log",
  acacia_planks: "acacia_log",
  dark_oak_planks: "dark_oak_log",
  mangrove_planks: "mangrove_log",
  cherry_planks: "cherry_log",
  crimson_planks: "crimson_stem",
  warped_planks: "warped_stem",
  bamboo_planks: "bamboo_block"
};

const DROP_SOURCE_BLOCKS: Record<string, string[]> = {
  coal: ["coal_ore", "deepslate_coal_ore"],
  redstone: ["redstone_ore", "deepslate_redstone_ore"],
  diamond: ["diamond_ore", "deepslate_diamond_ore"],
  emerald: ["emerald_ore", "deepslate_emerald_ore"],
  lapis_lazuli: ["lapis_ore", "deepslate_lapis_ore"],
  quartz: ["nether_quartz_ore"],
  clay_ball: ["clay"],
  flint: ["gravel"],
  string: ["cobweb"],
  amethyst_shard: ["amethyst_cluster"]
};

const RAW_GATHERABLE = new Set([
  "dirt",
  "coarse_dirt",
  "rooted_dirt",
  "mud",
  "sand",
  "red_sand",
  "gravel",
  "clay",
  "netherrack",
  "soul_sand",
  "soul_soil",
  "blackstone",
  "basalt",
  "calcite",
  "tuff",
  "dripstone_block",
  "moss_block",
  "snow_block",
  "ice",
  "packed_ice",
  "blue_ice",
  "obsidian",
  "end_stone",
  "cobblestone",
  "cobbled_deepslate"
]);

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot offline");
  return bot;
}

function countNamed(bot: Bot, names: Iterable<string>): number {
  const set = new Set(names);
  return bot.inventory.items().reduce((sum, item) => sum + (set.has(item.name) ? item.count : 0), 0);
}

function totalInventoryCount(bot: Bot): number {
  return bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
}

function droppedItemName(entity: unknown): string | null {
  const e = entity as {
    getDroppedItem?: () => { name?: string } | null;
    metadata?: unknown[];
  };
  try {
    return e.getDroppedItem?.()?.name ?? null;
  } catch {
    return null;
  }
}

function entityExists(bot: Bot, id: number | undefined): boolean {
  if (id == null) return false;
  return Boolean(bot.entities[id]);
}

/**
 * Yerdeki item entity'lerini gerçekten kaybolmain veya inventory artmain kadar takip eder.
 * Eski kod yalnızca targete yürüdüğü for, pickup gerçekleşmese bile başarı sayıyordu.
 */
export async function runSmartCollectDrops(
  instance: BotInstance,
  filter: string | undefined,
  radius: number,
  token: TaskToken,
  report: ProgressFn,
  maxDurationMs = 45_000
): Promise<number> {
  const bot = requireBot(instance);
  const normalizedFilter = filter?.replace(/^minecraft:/, "").toLowerCase();
  const startedAt = Date.now();
  const failures = new Map<number, number>();
  let verified = 0;
  let quietPasses = 0;

  while (!token.cancelled && Date.now() - startedAt < maxDurationMs) {
    const drops = (Object.values(bot.entities) as DropEntityLike[]).filter((entity) => {
      if (!entity || entity.name !== "item") return false;
      if (bot.entity.position.distanceTo(entity.position) > radius) return false;
      const name = droppedItemName(entity)?.toLowerCase();
      if (normalizedFilter && name && !name.includes(normalizedFilter)) return false;
      if ((failures.get(entity.id) ?? 0) >= 3) return false;
      return true;
    });

    if (!drops.length) {
      quietPasses++;
      if (quietPasses >= 2) break;
      await sleep(160);
      continue;
    }
    quietPasses = 0;
    drops.sort(
      (a, b) =>
        bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)
    );

    const target = drops[0]!;
    const beforeAll = totalInventoryCount(bot);
    const targetName = droppedItemName(target);
    const beforeNamed = targetName ? countNamed(bot, [targetName]) : beforeAll;
    report({
      done: verified,
      total: verified + drops.length,
      label: `Ground items: ${targetName ?? "item"}`
    });

    try {
      await runGoto(
        instance,
        target.position.x,
        target.position.y,
        target.position.z,
        0.65,
        token,
        () => {}
      );
    } catch {
      failures.set(target.id, (failures.get(target.id) ?? 0) + 1);
      await sleep(120);
      continue;
    }

    const waitUntil = Date.now() + 1_600;
    let picked = false;
    while (!token.cancelled && Date.now() < waitUntil) {
      const afterAll = totalInventoryCount(bot);
      const afterNamed = targetName ? countNamed(bot, [targetName]) : afterAll;
      if (!entityExists(bot, target.id) || afterAll > beforeAll || afterNamed > beforeNamed) {
        picked = true;
        break;
      }
      await sleep(80);
    }

    if (picked) {
      verified++;
      failures.delete(target.id);
    } else {
      failures.set(target.id, (failures.get(target.id) ?? 0) + 1);
      // Akıntıda veya blok forde remaining item for biraz farklı açıdan tekrar yaklaş.
      try {
        await runGoto(
          instance,
          target.position.x + 0.35,
          target.position.y,
          target.position.z + 0.35,
          0.55,
          token,
          () => {}
        );
      } catch {
        // best effort
      }
    }
  }

  if (token.cancelled) throw new Error(token.reason ?? "cancelled");
  report({ done: verified, total: verified, label: `Ground items withdrawn: ${verified}` });
  return verified;
}

/** Kazılan bloğun drop'unu, başka işe geçmeden önce toplar. */
export async function collectDropsAfterDig(
  instance: BotInstance,
  filter: string | undefined,
  token: TaskToken
): Promise<void> {
  await sleep(120);
  try {
    await runSmartCollectDrops(instance, filter, 7, token, () => {}, 3_200);
  } catch {
    // Kazma işlemini yalnızca pickup best-effort hatası yüzünden failed sayma.
  }
}

function directBlockMatcher(requested: string): (name: string) => boolean {
  const dropSources = DROP_SOURCE_BLOCKS[requested];
  if (dropSources) {
    const sourceSet = new Set(dropSources);
    return (name) => sourceSet.has(name);
  }
  if (requested === "cobblestone") return (name) => name === "stone" || name === "cobblestone";
  if (requested === "cobbled_deepslate") return (name) => name === "deepslate" || name === "cobbled_deepslate";
  if (requested.endsWith("_wool")) return (name) => name === requested;
  if (requested.endsWith("_concrete")) return (name) => name === requested;
  return (name) => name === requested;
}

function isLikelyCraftedItem(name: string): boolean {
  return (
    name.endsWith("_planks") ||
    name.endsWith("_stairs") ||
    name.endsWith("_slab") ||
    name.endsWith("_wall") ||
    name.endsWith("_fence") ||
    name.endsWith("_fence_gate") ||
    name.endsWith("_door") ||
    name.endsWith("_trapdoor") ||
    name.endsWith("_button") ||
    name.endsWith("_pressure_plate") ||
    name.endsWith("_sign") ||
    name.endsWith("_hanging_sign") ||
    name.endsWith("_carpet") ||
    name.endsWith("_bricks") ||
    name.endsWith("_tiles") ||
    name === "stick" ||
    name === "ladder" ||
    name === "barrel" ||
    name === "lantern" ||
    name === "soul_lantern" ||
    name === "crafting_table" ||
    name === "furnace" ||
    name === "decorated_pot"
  );
}

/**
 * Build malzemesi for mantıklı kaynak çözümü.
 * - species planks yalnızca aynı species log/stem kullanır
 * - craftable sonuçlar doğrudan worldda aranmak yerine recipe zincirine gider
 * - doğrudan blok araması `includes` değil kesin isim eşleşmesidir
 */
export async function runSmartCollectBlock(
  instance: BotInstance,
  name: string,
  amount: number,
  token: TaskToken,
  report: ProgressFn,
  countMode: CountMode = "target"
): Promise<void> {
  const bot = requireBot(instance);
  const requested = name.replace(/^minecraft:/, "");
  const have = () => requested === "log"
    ? bot.inventory.items().reduce((sum, item) => sum + ((item.name.endsWith("_log") || item.name.endsWith("_stem")) ? item.count : 0), 0)
    : countNamed(bot, [requested]);
  const start = have();
  const target = countMode === "add"
    ? start + Math.max(1, Math.floor(amount))
    : Math.max(1, Math.floor(amount));

  if (requested.endsWith("_log") || requested.endsWith("_stem") || requested === "log") {
    await instance.gather.runCollectWood(
      target,
      requested === "log" ? undefined : requested,
      token,
      report,
      "target"
    );
    return;
  }

  const rawWood = WOOD_TO_PLANKS[requested];
  if (rawWood) {
    const missingPlanks = Math.max(0, target - have());
    if (!missingPlanks) return;
    const rawHave = countNamed(bot, [rawWood]);
    const rawTarget = rawHave + Math.ceil(missingPlanks / 4);
    report({ done: have(), total: target, label: `${requested} for ${rawWood} searching` });
    if (rawWood === "bamboo_block") {
      await runDirectWorldGather(instance, rawWood, rawTarget, token, report);
    } else {
      await instance.gather.runCollectWood(rawTarget, rawWood, token, report, "target");
    }
    await instance.craft.runCraftInline(requested, target, token, report);
    return;
  }

  if (requested.includes("_ore") || requested === "ancient_debris" || requested.startsWith("raw_")) {
    const ore = requested
      .replace(/^deepslate_/, "")
      .replace(/_ore$/, "")
      .replace(/^raw_/, "");
    await instance.gather.runMine(ore, target, "legit", token, report, "target");
    return;
  }

  if (instance.craft.canCraft(requested) || isLikelyCraftedItem(requested)) {
    try {
      await instance.craft.runCraftInline(requested, target, token, report);
      if (have() >= target) return;
    } catch {
      // Tarif/ham madde zinciri çözülemezse aşağıda kesin blok aramasına düşer.
    }
  }

  await runDirectWorldGather(instance, requested, target, token, report);
}

async function runDirectWorldGather(
  instance: BotInstance,
  requested: string,
  target: number,
  token: TaskToken,
  report: ProgressFn
): Promise<void> {
  const bot = requireBot(instance);
  const matcher = directBlockMatcher(requested);
  const countHave = () => {
    if (requested === "cobblestone") return countNamed(bot, ["cobblestone"]);
    if (requested === "cobbled_deepslate") return countNamed(bot, ["cobbled_deepslate"]);
    return countNamed(bot, [requested]);
  };

  let got = countHave();
  report({ done: Math.min(got, target), total: target, label: `${requested} ${got}/${target}` });
  let noProgress = 0;

  while (got < target && !token.cancelled) {
    let block = bot.findBlock({ matching: (b) => matcher(b.name), maxDistance: 32 });
    if (!block) {
      const found = await ringSearch(instance, token, report, {
        step: RAW_GATHERABLE.has(requested) ? 24 : 28,
        maxRadius: RAW_GATHERABLE.has(requested) ? 96 : 112,
        probe: (probeBot) =>
          Boolean(probeBot.findBlock({ matching: (candidate) => matcher(candidate.name), maxDistance: 20 }))
      });
      if (!found) throw new Error(`${requested} not found (area search exhausted)`);
      block = bot.findBlock({ matching: (b) => matcher(b.name), maxDistance: 32 });
    }
    if (!block) continue;

    const before = got;
    // Mevcut GatherService'in safe tool/path/dig akışını kullmainbilmek for
    // tek targetli bir blok toplama yerine doğrudan kazma API'si yok; aynı dosyadaki
    // digBlock bu çağrıdan sonra drop pickup ile yamalanır. Burada blok yakınına gideriz.
    await runGoto(instance, block.position.x, block.position.y, block.position.z, 3, token, () => {});
    if (token.cancelled) throw new Error(token.reason ?? "cancelled");

    const live = bot.blockAt(block.position);
    if (!live || !matcher(live.name) || !bot.canDigBlock(live)) {
      noProgress++;
      if (noProgress >= 5) throw new Error(`${requested}: no diggable target found`);
      continue;
    }

    try {
      const toolBot = bot as unknown as {
        tool?: { equipForBlock(block: unknown): Promise<void> };
        loadPlugin(plugin: unknown): void;
      };
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const toolPlugin = require("mineflayer-tool").plugin;
        if (!toolBot.tool) toolBot.loadPlugin(toolPlugin);
        await toolBot.tool?.equipForBlock(live);
      } catch {
        // optional plugin
      }
      await bot.dig(live);
      await collectDropsAfterDig(instance, requested, token);
    } catch (error) {
      noProgress++;
      if (noProgress >= 5) {
        throw new Error(
          `${requested} could not dig: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      continue;
    }

    got = countHave();
    noProgress = got > before ? 0 : noProgress + 1;
    report({ done: Math.min(got, target), total: target, label: `${requested} ${got}/${target}` });
    if (noProgress >= 5) throw new Error(`${requested}: dug but drop did not enter inventory`);
  }

  if (token.cancelled) throw new Error(token.reason ?? "cancelled");
}

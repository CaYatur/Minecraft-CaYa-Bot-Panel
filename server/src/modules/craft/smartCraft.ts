import type { Bot } from "mineflayer";
import type { BotInstance } from "../../core/BotInstance";
import type { ProgressFn, TaskToken } from "../../core/TaskQueue";
import { runGoto } from "../movement";
import { withdrawBuildMaterials } from "../build/storage";
import type { CraftPlanStep } from "./index";

interface RecipeDelta {
  id: number;
  count: number;
}

interface RecipeLike {
  delta?: RecipeDelta[];
  result?: { id?: number; count?: number; name?: string };
  requiresTable?: boolean;
  inShape?: unknown[][];
  ingredients?: unknown[];
}

interface SmartCraftContext {
  instance: BotInstance;
  bot: Bot;
  token: TaskToken;
  report: ProgressFn;
  stack: Set<string>;
  stepsDone: number;
  portableTable?: { x: number; y: number; z: number };
  portableFurnace?: { x: number; y: number; z: number };
}

const MAX_DEPTH = 12;

const SMELT_INPUTS: Record<string, string[]> = {
  stone: ["cobblestone"],
  smooth_stone: ["stone"],
  glass: ["sand", "red_sand"],
  iron_ingot: ["raw_iron", "iron_ore", "deepslate_iron_ore"],
  gold_ingot: ["raw_gold", "gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
  copper_ingot: ["raw_copper", "copper_ore", "deepslate_copper_ore"],
  brick: ["clay_ball"],
  nether_brick: ["netherrack"],
  charcoal: ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log"]
};

const KNOWN_CRAFTED_SUFFIXES = [
  "_planks",
  "_stairs",
  "_slab",
  "_wall",
  "_fence",
  "_fence_gate",
  "_door",
  "_trapdoor",
  "_button",
  "_pressure_plate",
  "_sign",
  "_hanging_sign",
  "_carpet",
  "_bricks",
  "_tiles"
];

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalize(name: string) {
  return name.replace(/^minecraft:/, "");
}

function requireBot(instance: BotInstance): Bot {
  const bot = instance.bot;
  if (!bot || instance.status !== "online") throw new Error("Bot çevrimdışı");
  return bot;
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().reduce((sum, item) => sum + (item.name === name ? item.count : 0), 0);
}

function recipeCandidates(bot: Bot, itemId: number): RecipeLike[] {
  const out: RecipeLike[] = [];
  const anyBot = bot as unknown as {
    recipesAll?: (id: number, metadata: number | null, table: unknown) => RecipeLike[];
  };

  if (typeof anyBot.recipesAll === "function") {
    for (const table of [null, true]) {
      try {
        const recipes = anyBot.recipesAll(itemId, null, table);
        if (Array.isArray(recipes)) out.push(...recipes);
      } catch {
        // Mineflayer sürüm farkı
      }
    }
  }

  const registry = bot.registry as unknown as {
    recipes?: Record<string | number, RecipeLike[] | RecipeLike>;
    recipesByResult?: Record<string | number, RecipeLike[] | RecipeLike>;
  };
  for (const source of [registry.recipes?.[itemId], registry.recipesByResult?.[itemId]]) {
    if (Array.isArray(source)) out.push(...source);
    else if (source && typeof source === "object") out.push(source);
  }

  return [...new Set(out)];
}

function recipeOutputCount(recipe: RecipeLike, itemId: number): number {
  const deltaCount = recipe.delta?.find((d) => d.id === itemId && d.count > 0)?.count;
  return Math.max(1, Number(deltaCount ?? recipe.result?.count ?? 1));
}

function recipeIngredients(recipe: RecipeLike): Map<number, number> {
  const result = new Map<number, number>();
  for (const delta of recipe.delta ?? []) {
    if (delta.count >= 0) continue;
    result.set(delta.id, (result.get(delta.id) ?? 0) + Math.abs(delta.count));
  }
  return result;
}

function woodFamily(name: string): string | null {
  for (const family of [
    "dark_oak",
    "mangrove",
    "cherry",
    "spruce",
    "birch",
    "jungle",
    "acacia",
    "crimson",
    "warped",
    "bamboo",
    "oak"
  ]) {
    if (name.startsWith(`${family}_`)) return family;
  }
  return null;
}

function selectRecipe(bot: Bot, itemName: string, itemId: number): RecipeLike | null {
  const recipes = recipeCandidates(bot, itemId);
  if (!recipes.length) return null;
  const family = woodFamily(itemName);

  recipes.sort((a, b) => {
    const score = (recipe: RecipeLike) => {
      let value = 0;
      const ingredients = recipeIngredients(recipe);
      for (const id of ingredients.keys()) {
        const name = bot.registry.items[id]?.name ?? "";
        if (family && name.startsWith(`${family}_`)) value += 30;
        if (family && woodFamily(name) && !name.startsWith(`${family}_`)) value -= 20;
        value -= countItem(bot, name) > 0 ? 0 : 1;
      }
      value -= ingredients.size;
      return value;
    };
    return score(b) - score(a);
  });
  return recipes[0] ?? null;
}

function knownCraftable(name: string): boolean {
  return (
    KNOWN_CRAFTED_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    [
      "stick",
      "ladder",
      "barrel",
      "lantern",
      "soul_lantern",
      "crafting_table",
      "furnace",
      "chest",
      "decorated_pot"
    ].includes(name)
  );
}

export function smartCanCraft(instance: BotInstance, item: string): boolean {
  const bot = instance.bot;
  if (!bot) return false;
  const name = normalize(item);
  if (SMELT_INPUTS[name] || (name.endsWith("_concrete") && !name.endsWith("_concrete_powder"))) return true;
  const id = bot.registry.itemsByName[name]?.id;
  if (id == null) return false;
  return recipeCandidates(bot, id).length > 0 || knownCraftable(name);
}

export function smartPreviewPlan(instance: BotInstance, item: string, count = 1): CraftPlanStep[] {
  const bot = instance.bot;
  const name = normalize(item);
  const target = Math.max(1, Math.floor(count));
  if (!bot) return heuristicPlan(name, target);
  const plan: CraftPlanStep[] = [];
  const virtualHave = new Map<string, number>();

  const walk = (current: string, wanted: number, depth: number, stack: Set<string>) => {
    if (depth > MAX_DEPTH || stack.has(current)) {
      plan.push({ kind: "gather", item: current, count: wanted, note: "zincir sınırı" });
      return;
    }
    const realHave = countItem(bot, current);
    const have = Math.max(realHave, virtualHave.get(current) ?? 0);
    if (have >= wanted) return;
    const missing = wanted - have;

    const smeltInputs = SMELT_INPUTS[current];
    if (smeltInputs) {
      walk(smeltInputs[0]!, countItem(bot, smeltInputs[0]!) + missing, depth + 1, new Set([...stack, current]));
      plan.push({ kind: "smelt", item: current, count: missing });
      virtualHave.set(current, wanted);
      return;
    }

    const id = bot.registry.itemsByName[current]?.id;
    const recipe = id == null ? null : selectRecipe(bot, current, id);
    if (!recipe || id == null) {
      plan.push({ kind: "gather", item: current, count: missing });
      virtualHave.set(current, wanted);
      return;
    }

    const output = recipeOutputCount(recipe, id);
    const operations = Math.ceil(missing / output);
    for (const [ingredientId, perOperation] of recipeIngredients(recipe)) {
      const ingredient = bot.registry.items[ingredientId]?.name;
      if (!ingredient) continue;
      walk(
        ingredient,
        countItem(bot, ingredient) + perOperation * operations,
        depth + 1,
        new Set([...stack, current])
      );
    }
    plan.push({ kind: "craft", item: current, count: missing });
    virtualHave.set(current, wanted);
  };

  walk(name, target, 0, new Set());
  return plan;
}

export async function runSmartCraftInline(
  instance: BotInstance,
  item: string,
  count: number,
  token: TaskToken,
  report: ProgressFn
): Promise<void> {
  const bot = requireBot(instance);
  const name = normalize(item);
  const target = Math.max(1, Math.min(4096, Math.floor(count)));
  const ctx: SmartCraftContext = {
    instance,
    bot,
    token,
    report,
    stack: new Set(),
    stepsDone: 0
  };

  try {
    await ensureItem(ctx, name, target, 0);
    const finalCount = countItem(bot, name);
    if (finalCount < target) {
      throw new Error(`${name}: hedef ${target}, envanter ${finalCount}`);
    }
    report({ done: target, total: target, label: `Craft tamam: ${name} ×${finalCount}` });
  } finally {
    await cleanupPortableBlock(ctx, "crafting_table", ctx.portableTable);
    await cleanupPortableBlock(ctx, "furnace", ctx.portableFurnace);
  }
}

async function ensureItem(
  ctx: SmartCraftContext,
  itemName: string,
  targetCount: number,
  depth: number
): Promise<void> {
  const { bot, instance, token, report } = ctx;
  if (token.cancelled) throw new Error(token.reason ?? "iptal");
  if (depth > MAX_DEPTH) throw new Error(`${itemName}: craft zinciri çok derin`);
  if (countItem(bot, itemName) >= targetCount) return;
  if (ctx.stack.has(itemName)) throw new Error(`${itemName}: döngüsel craft zinciri`);

  ctx.stack.add(itemName);
  try {
    let missing = targetCount - countItem(bot, itemName);

    // Önce oyuncunun yakındaki sandık/barrel/shulker depolarını kullan.
    if (missing > 0) {
      await withdrawBuildMaterials(instance, [itemName], missing, token, (label) => {
        report({ done: countItem(bot, itemName), total: targetCount, label });
      });
      missing = targetCount - countItem(bot, itemName);
      if (missing <= 0) return;
    }

    if (itemName.endsWith("_concrete") && !itemName.endsWith("_concrete_powder")) {
      await hardenConcreteToTarget(ctx, itemName, targetCount, depth);
      return;
    }

    const smeltInputs = SMELT_INPUTS[itemName];
    if (smeltInputs) {
      await smeltToTarget(ctx, itemName, targetCount, smeltInputs, depth);
      return;
    }

    const itemId = bot.registry.itemsByName[itemName]?.id;
    const recipe = itemId == null ? null : selectRecipe(bot, itemName, itemId);
    if (!recipe || itemId == null) {
      report({ done: countItem(bot, itemName), total: targetCount, label: `Toplanıyor: ${itemName}` });
      await instance.gather.runCollectBlock(itemName, targetCount, token, report);
      return;
    }

    const outputCount = recipeOutputCount(recipe, itemId);
    const operations = Math.ceil((targetCount - countItem(bot, itemName)) / outputCount);
    const ingredients = recipeIngredients(recipe);
    if (!ingredients.size) {
      throw new Error(`${itemName}: tarif girdileri okunamadı`);
    }

    for (const [ingredientId, perOperation] of ingredients) {
      const ingredient = bot.registry.items[ingredientId]?.name;
      if (!ingredient) throw new Error(`${itemName}: tarif girdisi bilinmiyor (${ingredientId})`);
      const ingredientTarget = countItem(bot, ingredient) + perOperation * operations;
      report({
        done: ctx.stepsDone,
        total: ctx.stepsDone + ingredients.size + 1,
        label: `${itemName} için ${ingredient} hazırlanıyor`
      });
      await ensureItem(ctx, ingredient, ingredientTarget, depth + 1);
    }

    await executeRecipe(ctx, itemName, itemId, targetCount, recipe);
  } finally {
    ctx.stack.delete(itemName);
  }
}

async function executeRecipe(
  ctx: SmartCraftContext,
  itemName: string,
  itemId: number,
  targetCount: number,
  selected: RecipeLike
): Promise<void> {
  const { bot, token, report } = ctx;
  let guard = 0;

  while (countItem(bot, itemName) < targetCount && guard++ < 128) {
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    const missing = targetCount - countItem(bot, itemName);
    const output = recipeOutputCount(selected, itemId);
    const wantedOperations = Math.max(1, Math.ceil(missing / output));

    let table: unknown = null;
    let executable = bot.recipesFor(itemId, null, 1, null) as unknown[];
    if (!executable.length) {
      table = await ensureCraftingTable(ctx);
      executable = bot.recipesFor(itemId, null, 1, table as never) as unknown[];
    }
    if (!executable.length) throw new Error(`Tarif uygulanamıyor: ${itemName}`);

    const before = countItem(bot, itemName);
    report({ done: before, total: targetCount, label: `Craft: ${itemName} ${before}/${targetCount}` });
    try {
      await bot.craft(executable[0] as never, wantedOperations, (table ?? undefined) as never);
    } catch {
      // Bazı sunucular toplu craft paketini reddeder; tekli dene.
      await bot.craft(executable[0] as never, 1, (table ?? undefined) as never);
    }
    await sleep(80);
    const after = countItem(bot, itemName);
    if (after <= before) throw new Error(`${itemName}: craft sonrası envanter artmadı`);
    ctx.stepsDone++;
  }

  if (countItem(bot, itemName) < targetCount) {
    throw new Error(`${itemName}: craft deneme sınırı`);
  }
}

async function ensureCraftingTable(ctx: SmartCraftContext): Promise<unknown> {
  const { bot, token } = ctx;
  let table = bot.findBlock({ matching: (block) => block.name === "crafting_table", maxDistance: 20 });
  if (table) {
    if (bot.entity.position.distanceTo(table.position) > 4.5) {
      await runGoto(ctx.instance, table.position.x, table.position.y, table.position.z, 3, token, () => {});
      table = bot.blockAt(table.position) ?? table;
    }
    return table;
  }

  await ensureItem(ctx, "crafting_table", Math.max(1, countItem(bot, "crafting_table") + 1), 1);
  const placed = await placePortableBlock(ctx, "crafting_table");
  ctx.portableTable = placed.position;
  return placed.block;
}

async function placePortableBlock(
  ctx: SmartCraftContext,
  itemName: string
): Promise<{ block: unknown; position: { x: number; y: number; z: number } }> {
  const { bot, token } = ctx;
  if (token.cancelled) throw new Error(token.reason ?? "iptal");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vec3Module = require("vec3");
  const Vec3 = (vec3Module.Vec3 ?? vec3Module) as new (x: number, y: number, z: number) => {
    x: number;
    y: number;
    z: number;
  };
  const bx = Math.floor(bot.entity.position.x);
  const by = Math.floor(bot.entity.position.y);
  const bz = Math.floor(bot.entity.position.z);
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1]
  ];

  for (const [dx, dz] of offsets) {
    const target = new Vec3(bx + dx!, by, bz + dz!);
    const supportPos = new Vec3(target.x, target.y - 1, target.z);
    const targetBlock = bot.blockAt(target as never);
    const support = bot.blockAt(supportPos as never);
    if (!support || support.name.includes("air") || support.name === "water" || support.name === "lava") continue;
    if (targetBlock && !targetBlock.name.includes("air")) continue;

    const item = bot.inventory.items().find((entry) => entry.name === itemName);
    if (!item) throw new Error(`${itemName} envanterde yok`);
    try {
      bot.pathfinder?.setGoal(null);
      bot.clearControlStates();
      await sleep(90);
      await bot.equip(item, "hand");
      await bot.lookAt(support.position.offset(0.5, 0.8, 0.5), false);
      await bot.placeBlock(support, new Vec3(0, 1, 0) as never);
      await sleep(120);
      const placed = bot.blockAt(target as never);
      if (placed?.name === itemName) {
        return { block: placed, position: { x: target.x, y: target.y, z: target.z } };
      }
    } catch {
      // sonraki güvenli yüzey
    }
  }
  throw new Error(`${itemName} için güvenli geçici yer bulunamadı`);
}

async function hardenConcreteToTarget(
  ctx: SmartCraftContext,
  concreteName: string,
  targetCount: number,
  depth: number
): Promise<void> {
  const { bot, token, report } = ctx;
  const powderName = concreteName.replace(/_concrete$/, "_concrete_powder");
  let missing = targetCount - countItem(bot, concreteName);
  if (missing <= 0) return;

  await ensureItem(ctx, powderName, countItem(bot, powderName) + missing, depth + 1);
  const workstation = findConcreteWaterEdge(bot);
  if (!workstation) {
    throw new Error(`${concreteName}: yakınlarda güvenli su kenarı bulunamadı`);
  }

  await runGoto(
    ctx.instance,
    workstation.target.x + 0.5,
    workstation.target.y,
    workstation.target.z + 0.5,
    3,
    token,
    () => {}
  );

  while (!token.cancelled && countItem(bot, concreteName) < targetCount) {
    const powder = bot.inventory.items().find((item) => item.name === powderName);
    if (!powder) throw new Error(`${concreteName}: ${powderName} tükendi`);
    const targetBlock = bot.blockAt(workstation.target);
    if (targetBlock && !targetBlock.name.includes("air")) {
      throw new Error(`${concreteName}: su kenarı çalışma hücresi doldu`);
    }

    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
    await sleep(90);
    await bot.equip(powder, "hand");
    await bot.lookAt(workstation.support.position.offset(0.5, 0.8, 0.5), false);
    await bot.placeBlock(workstation.support, workstation.face);
    await sleep(160);

    const hardened = bot.blockAt(workstation.target);
    if (!hardened || hardened.name !== concreteName) {
      if (hardened?.name === powderName && bot.canDigBlock(hardened)) {
        try { await bot.dig(hardened); } catch { /* */ }
      }
      throw new Error(`${concreteName}: powder suyla temas edip sertleşmedi`);
    }

    try {
      const toolBot = bot as unknown as { tool?: { equipForBlock(block: unknown): Promise<void> } };
      await toolBot.tool?.equipForBlock(hardened);
    } catch {
      // elle kazmayı dene
    }
    await bot.dig(hardened);
    await ctx.instance.gather.runCollectDrops(concreteName, 7, token, () => {});
    missing = targetCount - countItem(bot, concreteName);
    report({
      done: countItem(bot, concreteName),
      total: targetCount,
      label: `Suyla sertleştiriliyor: ${concreteName} · kalan ${Math.max(0, missing)}`
    });
  }

  if (token.cancelled) throw new Error(token.reason ?? "iptal");
}

function findConcreteWaterEdge(bot: Bot): {
  target: import("vec3").Vec3;
  support: NonNullable<ReturnType<Bot["blockAt"]>>;
  face: import("vec3").Vec3;
} | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vec3Module = require("vec3");
  const Vec3 = vec3Module.Vec3 ?? vec3Module;
  const waters = bot.findBlocks({
    matching: (block) => block.name === "water" || block.name === "flowing_water",
    maxDistance: 24,
    count: 64
  });
  waters.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
  for (const water of waters) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const target = new Vec3(water.x + dx!, water.y, water.z + dz!);
      const current = bot.blockAt(target);
      const support = bot.blockAt(target.offset(0, -1, 0));
      if (current && !current.name.includes("air")) continue;
      if (!support || support.name.includes("air") || support.name === "water" || support.name === "lava") continue;
      return { target, support, face: new Vec3(0, 1, 0) };
    }
  }
  return null;
}

async function smeltToTarget(
  ctx: SmartCraftContext,
  outputName: string,
  targetCount: number,
  candidates: string[],
  depth: number
): Promise<void> {
  const { bot, token, report } = ctx;
  let missing = targetCount - countItem(bot, outputName);
  if (missing <= 0) return;

  let inputName = candidates.find((candidate) => countItem(bot, candidate) > 0) ?? candidates[0]!;
  await ensureItem(ctx, inputName, countItem(bot, inputName) + missing, depth + 1);
  if (countItem(bot, inputName) < missing) {
    inputName = candidates.find((candidate) => countItem(bot, candidate) >= missing) ?? inputName;
  }

  let furnaceBlock = bot.findBlock({ matching: (block) => block.name === "furnace", maxDistance: 20 });
  if (!furnaceBlock) {
    await ensureItem(ctx, "furnace", Math.max(1, countItem(bot, "furnace") + 1), depth + 1);
    const placed = await placePortableBlock(ctx, "furnace");
    ctx.portableFurnace = placed.position;
    furnaceBlock = placed.block as never;
  } else if (bot.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
    await runGoto(ctx.instance, furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 3, token, () => {});
    furnaceBlock = bot.blockAt(furnaceBlock.position) ?? furnaceBlock;
  }

  let fuel = bot.inventory.items().find((item) => item.name === "coal" || item.name === "charcoal");
  if (!fuel) {
    fuel = bot.inventory.items().find((item) => item.name.endsWith("_planks") || item.name.endsWith("_log"));
  }
  if (!fuel) {
    await ensureItem(ctx, "oak_planks", countItem(bot, "oak_planks") + Math.ceil(missing / 1.5), depth + 1);
    fuel = bot.inventory.items().find((item) => item.name === "oak_planks");
  }
  if (!fuel) throw new Error(`${outputName}: fırın yakıtı yok`);

  const input = bot.inventory.items().find((item) => item.name === inputName);
  if (!input) throw new Error(`${outputName}: fırın girdisi yok (${inputName})`);

  const openFurnace = (bot as unknown as { openFurnace(block: unknown): Promise<unknown> }).openFurnace;
  if (typeof openFurnace !== "function") throw new Error("Mineflayer openFurnace desteği yok");
  const furnace = (await openFurnace.call(bot, furnaceBlock)) as {
    putInput(type: number, metadata: number | null, count: number): Promise<void>;
    putFuel(type: number, metadata: number | null, count: number): Promise<void>;
    outputItem(): { count: number } | null;
    takeOutput(): Promise<unknown>;
    close(): void;
  };

  try {
    await furnace.putInput(input.type, input.metadata ?? null, Math.min(missing, input.count));
    const fuelNeeded = fuel.name === "coal" || fuel.name === "charcoal" ? Math.ceil(missing / 8) : Math.ceil(missing / 1.5);
    await furnace.putFuel(fuel.type, fuel.metadata ?? null, Math.min(fuel.count, Math.max(1, fuelNeeded)));

    const deadline = Date.now() + Math.min(300_000, missing * 11_000 + 15_000);
    let last = countItem(bot, outputName);
    while (!token.cancelled && Date.now() < deadline && countItem(bot, outputName) < targetCount) {
      const out = furnace.outputItem();
      if (out?.count) {
        await furnace.takeOutput();
        await sleep(80);
      }
      const current = countItem(bot, outputName);
      if (current !== last) {
        last = current;
        report({ done: current, total: targetCount, label: `Eritiliyor: ${outputName} ${current}/${targetCount}` });
      }
      await sleep(350);
    }
  } finally {
    furnace.close();
  }

  if (token.cancelled) throw new Error(token.reason ?? "iptal");
  if (countItem(bot, outputName) < targetCount) {
    throw new Error(`${outputName}: fırın hedefi tamamlanamadı`);
  }
}

async function cleanupPortableBlock(
  ctx: SmartCraftContext,
  expectedName: string,
  position: { x: number; y: number; z: number } | undefined
): Promise<void> {
  if (!position) return;
  const { bot } = ctx;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vec3Module = require("vec3");
    const Vec3 = vec3Module.Vec3 ?? vec3Module;
    const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
    if (!block || block.name !== expectedName || !bot.canDigBlock(block)) return;
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
    await sleep(80);
    await bot.dig(block);
    await sleep(120);
    await ctx.instance.gather.runCollectDrops(expectedName, 7, { cancelled: false }, () => {});
  } catch {
    ctx.instance.getLogger().warn(`Geçici ${expectedName} geri alınamadı`);
  }
}

function heuristicPlan(item: string, count: number): CraftPlanStep[] {
  const family = woodFamily(item) ?? "oak";
  if (item.endsWith("_planks")) {
    const raw = family === "crimson" || family === "warped" ? `${family}_stem` : `${family}_log`;
    return [
      { kind: "gather", item: raw, count: Math.ceil(count / 4) },
      { kind: "craft", item, count }
    ];
  }
  if (SMELT_INPUTS[item]) {
    return [
      { kind: "gather", item: SMELT_INPUTS[item]![0]!, count },
      { kind: "smelt", item, count }
    ];
  }
  return [{ kind: "craft", item, count }];
}

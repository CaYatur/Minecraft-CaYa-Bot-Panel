import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY } from "../../core/TaskQueue";
import { runGoto } from "../movement";

export function enqueueFish(inst: BotInstance): void {
  inst.tasks.enqueue({ type: "fish", label: "AFK fish", priority: PRIORITY.AUTO, params: {}, requeueOnPreempt: false }, () => async (token) => {
    const bot = inst.bot;
    if (!bot || inst.status !== "online") throw new Error("Bot is offline.");
    const rod = bot.inventory.items().find((item) => item.name === "fishing_rod");
    if (!rod) throw new Error("No fishing rod in the inventory.");
    await bot.equip(rod, "hand");
    if (token.cancelled) return;
    await bot.fish();
  });
}

export function enqueueSleep(inst: BotInstance): void {
  inst.tasks.enqueue({ type: "sleep", label: "sleep in bed", priority: PRIORITY.AUTO, params: {}, requeueOnPreempt: false }, () => async (token, report) => {
    const bot = inst.bot;
    if (!bot || inst.status !== "online") throw new Error("Bot is offline.");
    report({ done: 0, total: 2, label: "looking for a bed" });
    const bed = bot.findBlock({ matching: (block) => Boolean(bot.isABed(block)), maxDistance: 32 });
    if (!bed) throw new Error("No bed within 32 blocks.");
    await runGoto(inst, bed.position.x, bed.position.y, bed.position.z, 2, token, report);
    if (token.cancelled) return;
    report({ done: 1, total: 2, label: "sleeping" });
    await bot.sleep(bed);
  });
}

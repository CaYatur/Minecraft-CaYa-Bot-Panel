import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { fmtPos } from "../lib/format";
import type { ChestMemory } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

export function RememberedChests({ botId }: { botId: string }) {
  const { t } = useI18n();
  const bot = useAppStore((s) => s.bots[botId]);
  const chests = useAppStore((s) => s.worldMemory.chests);
  const toast = useAppStore((s) => s.toast);

  if (!bot) return null;
  const mine = chests.filter((c) => c.serverId === bot.config.serverId);

  const forget = async (chest: ChestMemory) => {
    try {
      await api.del(`/api/bots/${botId}/chests/${chest.id}`);
      toast("info", t("gatherCraft.forgetChestToast", { pos: fmtPos(chest) }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] text-zinc-500">{t("gatherCraft.rememberedChests")}</div>
      {mine.length === 0 ? (
        <p className="text-[11px] text-zinc-600 italic">{t("gatherCraft.noRememberedChests")}</p>
      ) : (
        <div className="max-h-36 space-y-1 overflow-y-auto">
          {mine.map((c) => {
            const kinds = c.items.length;
            const total = c.items.reduce((n, i) => n + i.count, 0);
            return (
              <div key={c.id} className="flex items-center gap-2 rounded-lg bg-zinc-900/60 px-2 py-1.5 text-sm">
                <span className="mono text-[11px] text-zinc-300">{fmtPos(c)}</span>
                <span className="truncate text-[10px] text-zinc-500">{c.dimension}</span>
                <span className="text-[10px] text-zinc-500">
                  {t("gatherCraft.chestStock", { kinds, total })}
                </span>
                <button
                  type="button"
                  onClick={() => void forget(c)}
                  title={t("gatherCraft.forgetChestHint")}
                  className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-xs text-red-300 hover:bg-zinc-700"
                >
                  {t("gatherCraft.forgetChest")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

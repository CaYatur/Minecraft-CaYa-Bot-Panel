import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";
import { ItemPicker } from "./ItemPicker";

export function GatherCraftPanel({ botId }: { botId: string }) {
  const { t } = useI18n();
  const bot = useAppStore((s) => s.bots[botId]);
  const servers = useAppStore((s) => s.servers);
  const toast = useAppStore((s) => s.toast);
  const [woodN, setWoodN] = useState("16");
  const [woodType, setWoodType] = useState("oak_log");
  const [ore, setOre] = useState("iron_ore");
  const [oreN, setOreN] = useState("8");
  const [mode, setMode] = useState<"legit" | "utility">("legit");
  const [craftItem, setCraftItem] = useState("stick");
  const [craftN, setCraftN] = useState("1");
  const [plan, setPlan] = useState<Array<{ kind: string; item: string; count: number; note?: string }>>([]);

  if (!bot) return null;
  const online = bot.status === "online";
  const version = servers.find((s) => s.id === bot.config.serverId)?.version ?? "auto";

  const act = async (action: Record<string, unknown>, msg?: string) => {
    try {
      await api.post(`/api/bots/${botId}/action`, action);
      if (msg) toast("info", msg);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const loadPlan = async () => {
    try {
      const r = await api.get<{ plan: typeof plan }>(
        `/api/bots/${botId}/craft-plan?item=${encodeURIComponent(craftItem)}&count=${craftN}`
      );
      setPlan(r.plan ?? []);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const inputCls =
    "rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500";
  const btnSecondary =
    "rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40";
  const btnPrimary =
    "rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40";
  const btnAccent =
    "rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-emerald-300 hover:bg-zinc-700 disabled:opacity-40";

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {!online && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {t("gatherCraft.offline")}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            {t("gatherCraft.gather")}
          </div>
          <div className="mb-2">
            <span className="mb-1 block text-[10px] text-zinc-500">{t("gatherCraft.woodCatalog")}</span>
            <ItemPicker version={version} kind="blocks" value={woodType} onChange={setWoodType} placeholder="oak_log…" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={woodN}
              onChange={(e) => setWoodN(e.target.value)}
              title={t("gatherCraft.countTitle")}
              className={`mono w-16 ${inputCls}`}
            />
            <button
              disabled={!online}
              onClick={() =>
                act(
                  {
                    type: "collect-wood",
                    count: Number(woodN) || 16,
                    logType: woodType.endsWith("_log") ? woodType : undefined
                  },
                  t("gatherCraft.collectWoodToast")
                )
              }
              className={btnAccent}
            >
              {t("gatherCraft.collectWood")}
            </button>
            <button
              disabled={!online}
              onClick={() => act({ type: "collect-drops", radius: 16 }, t("gatherCraft.collectDropsToast"))}
              className={btnSecondary}
            >
              {t("gatherCraft.collectDrops")}
            </button>
          </div>

          <div className="mt-3 mb-1 text-[10px] text-zinc-500">{t("gatherCraft.oreCatalog")}</div>
          <ItemPicker version={version} kind="ores" value={ore} onChange={setOre} placeholder="iron_ore…" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input value={oreN} onChange={(e) => setOreN(e.target.value)} className={`mono w-14 ${inputCls}`} />
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "legit" | "utility")}
              className={`${inputCls} text-zinc-300`}
            >
              <option value="legit">legit</option>
              <option value="utility">utility</option>
            </select>
            <button
              disabled={!online}
              onClick={() =>
                act(
                  {
                    type: "mine",
                    ore: ore.replace(/_ore$/, "").replace(/^deepslate_/, ""),
                    count: Number(oreN) || 8,
                    mode
                  },
                  t("gatherCraft.mineToast", { ore })
                )
              }
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-amber-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              {t("gatherCraft.mine")}
            </button>
          </div>
          {mode === "utility" && (
            <p className="mt-2 text-[11px] text-amber-300/90">{t("gatherCraft.utilityWarn")}</p>
          )}
          <p className="mono mt-2 text-[10px] text-zinc-600">{t("gatherCraft.cmdGather")}</p>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            {t("gatherCraft.craft")}
          </div>
          <div className="mb-2">
            <span className="mb-1 block text-[10px] text-zinc-500">{t("gatherCraft.craftItem")}</span>
            <ItemPicker version={version} kind="items" value={craftItem} onChange={setCraftItem} placeholder="stick…" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={craftN} onChange={(e) => setCraftN(e.target.value)} className={`mono w-14 ${inputCls}`} />
            <button onClick={() => void loadPlan()} className={btnSecondary}>
              {t("gatherCraft.planPreview")}
            </button>
            <button
              disabled={!online}
              onClick={() =>
                act(
                  { type: "craft", item: craftItem, count: Number(craftN) || 1 },
                  t("gatherCraft.craftToast", { item: craftItem })
                )
              }
              className={btnPrimary}
            >
              {t("gatherCraft.craftConfirm")}
            </button>
          </div>
          <div className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-2 py-2">
            {plan.length === 0 && (
              <div className="py-2 text-center text-xs text-zinc-600 italic">{t("gatherCraft.planEmpty")}</div>
            )}
            {plan.map((p, i) => (
              <div key={i} className="mono text-[11px] text-zinc-400">
                <span className="text-zinc-600">#{i + 1}</span> {p.kind} · {p.item}×{p.count}
                {p.note ? <span className="text-zinc-600"> ({p.note})</span> : ""}
              </div>
            ))}
          </div>
          <p className="mono mt-2 text-[10px] text-zinc-600">{t("gatherCraft.cmdCraft")}</p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          {t("gatherCraft.storage")}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            disabled={!online}
            onClick={() => act({ type: "deposit" }, t("gatherCraft.depositToast"))}
            className={btnSecondary}
          >
            {t("gatherCraft.deposit")}
          </button>
          <button
            disabled={!online}
            onClick={() => {
              const item = prompt(t("gatherCraft.withdrawPrompt"));
              if (item) void act({ type: "withdraw", item, count: 16 });
            }}
            className={btnSecondary}
          >
            {t("gatherCraft.withdraw")}
          </button>
          <button
            disabled={!online}
            onClick={() => {
              const item = prompt(t("gatherCraft.fetchItemPrompt"));
              const player = prompt(t("gatherCraft.fetchPlayerPrompt")) || "";
              if (item) void act({ type: "fetch", item, count: 8, player });
            }}
            className={btnSecondary}
          >
            {t("gatherCraft.fetch")}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">{t("gatherCraft.keepItemsHint")}</p>
      </div>
    </div>
  );
}

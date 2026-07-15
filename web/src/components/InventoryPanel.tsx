import { useState } from "react";
import { api } from "../lib/api";
import type { InventoryItem, StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

const ARMOR = [
  { slot: 5, label: "Kask" },
  { slot: 6, label: "Göğüs" },
  { slot: 7, label: "Bacak" },
  { slot: 8, label: "Ayak" }
] as const;
const OFFHAND = 45;
const MAIN = Array.from({ length: 27 }, (_, i) => 9 + i);
const HOTBAR = Array.from({ length: 9 }, (_, i) => 36 + i);

function equipDest(name: string): string {
  if (name.endsWith("_helmet") || name === "turtle_helmet" || name === "carved_pumpkin") return "head";
  if (name.endsWith("_chestplate") || name === "elytra") return "torso";
  if (name.endsWith("_leggings")) return "legs";
  if (name.endsWith("_boots")) return "feet";
  if (name === "shield" || name === "totem_of_undying") return "off-hand";
  return "hand";
}

const SLOT_TO_DEST: Record<number, string> = { 5: "head", 6: "torso", 7: "legs", 8: "feet", [OFFHAND]: "off-hand" };

export function InventoryPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const [selected, setSelected] = useState<number | null>(null);

  if (!bot) return null;
  const inv = bot.inventory;
  const online = bot.status === "online";
  const { bannedItems, keepItems, autoBestGear } = bot.config.inventory;

  const item = (slot: number): InventoryItem | null => inv?.slots[slot] ?? null;
  const selectedItem = selected !== null ? item(selected) : null;
  const used = inv ? MAIN.concat(HOTBAR).filter((s) => inv.slots[s]).length : 0;

  const op = async (body: Record<string, unknown>, okMsg?: string) => {
    try {
      await api.post(`/api/bots/${botId}/inventory`, body);
      if (okMsg) toast("success", okMsg);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const patchInventoryConfig = async (patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/bots/${botId}`, { inventory: patch });
      applySnapshot(await api.get<StateSnapshot>("/api/state"));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const toggleList = (list: "bannedItems" | "keepItems", name: string) => {
    const cur = list === "bannedItems" ? bannedItems : keepItems;
    const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
    void patchInventoryConfig({ [list]: next });
  };

  const SlotBox = ({ slot, label, hotbarIndex }: { slot: number; label?: string; hotbarIndex?: number }) => {
    const it = item(slot);
    const isSel = selected === slot;
    const isHeld = hotbarIndex !== undefined && inv?.heldQuickBar === hotbarIndex;
    const banned = it ? bannedItems.includes(it.name) : false;
    const keep = it ? keepItems.includes(it.name) : false;
    const durPct = it?.durability ? (it.durability.left / it.durability.max) * 100 : null;

    return (
      <button
        onClick={() => setSelected(isSel ? null : slot)}
        title={
          it
            ? `${it.displayName} ×${it.count}` +
              (it.durability ? ` · dayanıklılık ${it.durability.left}/${it.durability.max}` : "") +
              (it.enchants.length ? ` · ${it.enchants.join(", ")}` : "") +
              (banned ? " · 🚫 yasaklı" : "") +
              (keep ? " · 📌 korunuyor" : "")
            : (label ?? "boş")
        }
        className={`relative flex h-14 w-14 flex-col items-center justify-center rounded-lg border text-center transition-colors ${
          isSel
            ? "border-indigo-400 bg-indigo-950/50"
            : it
              ? `bg-zinc-800/80 hover:bg-zinc-700/80 ${banned ? "border-red-700" : "border-zinc-700"}`
              : "border-dashed border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
        } ${isHeld ? "ring-2 ring-amber-400/80" : ""}`}
      >
        {it ? (
          <>
            <span className="line-clamp-2 px-0.5 text-[9px] leading-tight text-zinc-200">{it.displayName}</span>
            {it.count > 1 && (
              <span className="mono absolute right-0.5 bottom-0.5 rounded bg-zinc-950/80 px-1 text-[9px] font-bold text-zinc-100">
                {it.count}
              </span>
            )}
            {banned && <span className="absolute -top-1.5 -right-1.5 text-[11px]">🚫</span>}
            {keep && <span className="absolute -top-1.5 -left-1.5 text-[11px]">📌</span>}
            {durPct !== null && (
              <span className="absolute bottom-0 left-1 h-0.5 rounded-full" style={{ width: `${Math.max(8, durPct * 0.9)}%`, backgroundColor: durPct > 50 ? "#4ade80" : durPct > 20 ? "#fbbf24" : "#f87171" }} />
            )}
          </>
        ) : (
          <span className="text-[8px] text-zinc-700">{label ?? ""}</span>
        )}
        {hotbarIndex !== undefined && (
          <span className="mono absolute top-0.5 left-1 text-[8px] text-zinc-600">{hotbarIndex + 1}</span>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {!online && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          Bot çevrimdışı — {inv ? "son bilinen envanter gösteriliyor, işlemler kapalı." : "envanter verisi için botu başlat."}
        </div>
      )}

      <div className="flex flex-wrap items-start gap-6">
        {/* zırh + offhand */}
        <div className="flex flex-col gap-1.5">
          <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Zırh</div>
          {ARMOR.map((a) => (
            <SlotBox key={a.slot} slot={a.slot} label={a.label} />
          ))}
          <div className="mt-1 mb-0.5 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Sol El</div>
          <SlotBox slot={OFFHAND} label="Kalkan" />
        </div>

        {/* ana envanter + hotbar */}
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Envanter</span>
              <span className={`mono text-[10px] ${used >= 36 ? "text-red-400" : used >= 30 ? "text-amber-400" : "text-zinc-600"}`}>
                {used}/36 dolu
              </span>
            </div>
            <div className="grid grid-cols-9 gap-1.5">
              {MAIN.map((s) => (
                <SlotBox key={s} slot={s} />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Hotbar (sarı = elde)</div>
            <div className="grid grid-cols-9 gap-1.5">
              {HOTBAR.map((s, i) => (
                <SlotBox key={s} slot={s} hotbarIndex={i} />
              ))}
            </div>
          </div>
        </div>

        {/* ayarlar */}
        <div className="min-w-48 flex-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Otomatik</div>
          <label className="flex items-center gap-2 text-sm text-zinc-300" title="Kapatma, bot yeniden bağlanınca tam etkili olur">
            <input
              type="checkbox"
              checked={autoBestGear}
              onChange={(e) => void patchInventoryConfig({ autoBestGear: e.target.checked })}
            />
            En iyi zırhı otomatik giy
          </label>
          <div className="mt-3 mb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">🚫 Yasaklılar (bot kullanamaz)</div>
          <div className="flex flex-wrap gap-1">
            {bannedItems.length === 0 && <span className="text-xs text-zinc-600 italic">yok</span>}
            {bannedItems.map((n) => (
              <button
                key={n}
                onClick={() => toggleList("bannedItems", n)}
                className="mono rounded bg-red-950/60 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900/60"
                title="Yasağı kaldır"
              >
                {n} ×
              </button>
            ))}
          </div>
          <div className="mt-3 mb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">📌 Korunanlar (asla atılmaz)</div>
          <div className="flex flex-wrap gap-1">
            {keepItems.length === 0 && <span className="text-xs text-zinc-600 italic">yok</span>}
            {keepItems.map((n) => (
              <button
                key={n}
                onClick={() => toggleList("keepItems", n)}
                className="mono rounded bg-indigo-950/60 px-1.5 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-900/60"
                title="Korumayı kaldır"
              >
                {n} ×
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* aksiyon çubuğu */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        {selectedItem ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-2 text-sm text-zinc-200">
              <b>{selectedItem.displayName}</b> ×{selectedItem.count}
              {selectedItem.enchants.length > 0 && (
                <span className="ml-2 text-xs text-purple-300">{selectedItem.enchants.join(", ")}</span>
              )}
            </span>
            {online && (
              <>
                <ActionBtn onClick={() => op({ op: "hold", slot: selected }, "Ele alındı")}>✋ Eline Al</ActionBtn>
                {equipDest(selectedItem.name) !== "hand" && (
                  <ActionBtn onClick={() => op({ op: "equip", slot: selected }, "Kuşanıldı")}>🛡️ Kuşan</ActionBtn>
                )}
                {selected !== null && SLOT_TO_DEST[selected] && (
                  <ActionBtn onClick={() => op({ op: "unequip", dest: SLOT_TO_DEST[selected] }, "Çıkarıldı")}>Çıkar</ActionBtn>
                )}
                {selected !== null && selected >= 36 && selected <= 44 && (
                  <ActionBtn onClick={() => op({ op: "setHotbar", quickBar: selected - 36 })}>👆 Elde Seç</ActionBtn>
                )}
                <ActionBtn onClick={() => op({ op: "toss", slot: selected, amount: 1 })}>1 At</ActionBtn>
                <ActionBtn danger onClick={() => op({ op: "toss", slot: selected })}>
                  Hepsini At
                </ActionBtn>
              </>
            )}
            <ActionBtn onClick={() => selectedItem && toggleList("bannedItems", selectedItem.name)}>
              {bannedItems.includes(selectedItem.name) ? "🚫 Yasağı Kaldır" : "🚫 Yasakla"}
            </ActionBtn>
            <ActionBtn onClick={() => selectedItem && toggleList("keepItems", selectedItem.name)}>
              {keepItems.includes(selectedItem.name) ? "📌 Korumayı Kaldır" : "📌 Koru"}
            </ActionBtn>
          </div>
        ) : (
          <span className="text-xs text-zinc-600 italic">
            Bir eşyaya tıkla → işlemler burada çıkar (eline al, kuşan, at, yasakla, koru…)
          </span>
        )}
      </div>
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  danger
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
        danger ? "bg-red-950/60 text-red-300 hover:bg-red-900/60" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
      }`}
    >
      {children}
    </button>
  );
}

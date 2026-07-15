import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

export type CatalogKind = "items" | "blocks" | "ores" | "foods" | "tools" | "weapons";

interface CatalogEntry {
  id: string;
  name: string;
  displayName: string;
}

interface Catalog {
  version: string;
  resolvedVersion: string;
  items: CatalogEntry[];
  blocks: CatalogEntry[];
  ores: CatalogEntry[];
  foods: CatalogEntry[];
  tools: CatalogEntry[];
  weapons: CatalogEntry[];
}

const cache = new Map<string, Catalog>();

async function loadCatalog(version: string): Promise<Catalog> {
  const key = version || "auto";
  const hit = cache.get(key);
  if (hit) return hit;
  const cat = await api.get<Catalog>(`/api/catalog?version=${encodeURIComponent(key)}`);
  cache.set(key, cat);
  return cat;
}

/**
 * Sürüme göre eşya/maden seçici — yazmak yerine listeden (minecraft-data).
 * Tasarım: zinc input + açılır liste (Faz 0–5 dili).
 */
export function ItemPicker({
  version = "auto",
  kind = "items",
  value,
  onChange,
  placeholder = "Ara / seç…",
  className = ""
}: {
  version?: string;
  kind?: CatalogKind;
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    setQ(value);
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    loadCatalog(version)
      .then((c) => {
        if (!cancelled) {
          setCat(c);
          setErr("");
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const list = cat?.[kind] ?? [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return list.slice(0, 40);
    return list.filter((i) => i.name.includes(s) || i.displayName.toLowerCase().includes(s)).slice(0, 40);
  }, [list, q]);

  return (
    <div className={`relative ${className}`}>
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
      />
      {cat && (
        <div className="mt-0.5 text-[10px] text-zinc-600">
          katalog {cat.resolvedVersion} · {list.length} {kind}
        </div>
      )}
      {err && <div className="text-[10px] text-red-400">{err}</div>}
      {open && filtered.length > 0 && (
        <div className="absolute z-30 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
          {filtered.map((i) => (
            <button
              key={i.name}
              type="button"
              className={`flex w-full flex-col px-2 py-1.5 text-left text-xs hover:bg-zinc-800 ${
                value === i.name ? "bg-indigo-950/40 text-indigo-200" : "text-zinc-300"
              }`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(i.name);
                setQ(i.name);
                setOpen(false);
              }}
            >
              <span className="font-medium">{i.displayName}</span>
              <span className="mono text-[10px] text-zinc-500">{i.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAppStore } from "../stores/useAppStore";

interface SchematicMeta {
  id: string;
  name: string;
  filename: string;
  format: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  length?: number;
  blockCount?: number;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

interface SchematicDetail {
  meta: SchematicMeta;
  blockCount: number;
  size: { w: number; h: number; l: number };
  materials: Array<{ name: string; need: number }>;
}

/** Global yapı şemaları kütüphanesi (Faz 14) */
export function Schematics() {
  const toast = useAppStore((s) => s.toast);
  const [items, setItems] = useState<SchematicMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SchematicDetail | null>(null);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ items: SchematicMeta[] }>("/api/schematics");
      setItems(r.items ?? []);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .get<SchematicDetail>(`/api/schematics/${selected}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) toast("error", e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, toast]);

  const onFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const dataBase64 = btoa(binary);
      const meta = await api.post<SchematicMeta>("/api/schematics", {
        name: name.trim() || file.name.replace(/\.[^.]+$/, ""),
        filename: file.name,
        dataBase64,
        note: note.trim() || undefined
      });
      toast("success", `Yüklendi: ${meta.name}`);
      setName("");
      setNote("");
      await refresh();
      setSelected(meta.id);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Şema silinsin mi?")) return;
    try {
      await api.del(`/api/schematics/${id}`);
      toast("info", "Şema silindi");
      if (selected === id) setSelected(null);
      await refresh();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-zinc-100">Yapı şemaları</h1>
        <p className="mt-1 text-sm text-zinc-500">
          WorldEdit <span className="mono text-zinc-400">.schem</span>, Litematica{" "}
          <span className="mono text-zinc-400">.litematic</span> veya CaYa{" "}
          <span className="mono text-zinc-400">.caya.json</span>. Bot detay → Yapı sekmesinden inşa +
          döndür/aynala.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* liste + upload */}
        <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Kütüphane</div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {items.length === 0 && <p className="text-xs text-zinc-600 italic">Henüz şema yok.</p>}
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setSelected(it.id)}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  selected === it.id
                    ? "border-indigo-700 bg-indigo-950/40 text-indigo-100"
                    : "border-zinc-800 bg-zinc-950/40 text-zinc-300 hover:border-zinc-700"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{it.name}</span>
                <span className="mono shrink-0 text-[10px] text-zinc-500">
                  {it.blockCount != null ? `${it.blockCount} blok` : it.format}
                </span>
              </button>
            ))}
          </div>

          <div className="border-t border-zinc-800 pt-3 space-y-2">
            <div className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Yükle</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Görünen ad (opsiyonel)"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Not (opsiyonel)"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
            />
            <label className="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-zinc-700 bg-zinc-950/50 px-3 py-4 text-sm text-zinc-400 hover:border-indigo-600 hover:text-indigo-300">
              {uploading ? "Yükleniyor…" : "📂 .schem / .litematic / .caya.json seç"}
              <input
                type="file"
                accept=".schem,.schematic,.litematic,.json,.caya.json"
                className="hidden"
                disabled={uploading}
                onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
        </div>

        {/* detay */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Detay / malzemeler</div>
          {!detail && <p className="text-xs text-zinc-600 italic">Soldan bir şema seçin.</p>}
          {detail && (
            <div className="space-y-3">
              <div>
                <div className="text-lg font-semibold text-zinc-100">{detail.meta.name}</div>
                {detail.meta.note && <p className="text-xs text-zinc-500">{detail.meta.note}</p>}
                <p className="mono mt-1 text-[11px] text-zinc-500">
                  {detail.size.w}×{detail.size.h}×{detail.size.l} · {detail.blockCount} blok · {detail.meta.format} ·{" "}
                  {(detail.meta.sizeBytes / 1024).toFixed(1)} KB
                </p>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-800">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Blok</th>
                      <th className="px-2 py-1.5 font-medium text-right">Adet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.materials.map((m) => (
                      <tr key={m.name} className="border-t border-zinc-800/80">
                        <td className="mono px-2 py-1 text-zinc-300">{m.name}</td>
                        <td className="mono px-2 py-1 text-right text-zinc-400">{m.need}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={detail.meta.id === "sample-platform"}
                  onClick={() => void remove(detail.meta.id)}
                  className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/40 disabled:opacity-40"
                >
                  Sil
                </button>
                <span className="text-[10px] leading-relaxed text-zinc-600">
                  İnşa için bot detay sayfasındaki <b className="text-zinc-400">Yapı</b> sekmesini kullanın.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

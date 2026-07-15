import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BuildRuntime } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

interface SchematicMeta {
  id: string;
  name: string;
  blockCount?: number;
  width?: number;
  height?: number;
  length?: number;
  format: string;
}

const PHASE_TR: Record<BuildRuntime["phase"], string> = {
  idle: "Boşta",
  preparing: "Hazırlanıyor",
  building: "İnşa ediliyor",
  cleanup: "Scaffold temizlik",
  done: "Tamam",
  failed: "Hata",
  cancelled: "İptal"
};

const emptyBuild = (): BuildRuntime => ({
  phase: "idle",
  schematicId: null,
  schematicName: null,
  origin: null,
  placed: 0,
  total: 0,
  skipped: 0,
  scaffoldsPlaced: 0,
  scaffoldsCleared: 0,
  materials: [],
  label: "",
  startedAt: null
});

/** Bot detay — Yapı sekmesi (şema seç + origin + ilerleme + malzeme) */
export function BuildPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const servers = useAppStore((s) => s.servers);
  const [schematics, setSchematics] = useState<SchematicMeta[]>([]);
  const [schematicId, setSchematicId] = useState("");
  const [originMode, setOriginMode] = useState<"here" | "coords" | "player">("here");
  const [x, setX] = useState(0);
  const [y, setY] = useState(64);
  const [z, setZ] = useState(0);
  const [player, setPlayer] = useState("");
  const [allowPartial, setAllowPartial] = useState(false);
  const [preview, setPreview] = useState<{
    materials: Array<{ name: string; need: number; have: number; missing: number }>;
    blockCount: number;
    size: { w: number; h: number; l: number };
  } | null>(null);

  const build = bot?.build ?? emptyBuild();
  const online = bot?.status === "online";
  const busy = build.phase === "preparing" || build.phase === "building" || build.phase === "cleanup";

  useEffect(() => {
    api
      .get<{ items: SchematicMeta[] }>("/api/schematics")
      .then((r) => {
        setSchematics(r.items ?? []);
        if (!schematicId && r.items?.[0]) setSchematicId(r.items[0].id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  useEffect(() => {
    if (bot?.runtime.position && originMode === "here") {
      setX(Math.floor(bot.runtime.position.x));
      setY(Math.floor(bot.runtime.position.y));
      setZ(Math.floor(bot.runtime.position.z));
    }
  }, [bot?.runtime.position, originMode]);

  const loadPreview = useCallback(async () => {
    if (!schematicId || !online) {
      setPreview(null);
      return;
    }
    try {
      const server = servers.find((s) => s.id === bot?.config.serverId);
      const version = server?.version && server.version !== "auto" ? server.version : "1.20.4";
      const r = await api.get<{
        materials: Array<{ name: string; need: number; have: number; missing: number }>;
        blockCount: number;
        size: { w: number; h: number; l: number };
      }>(`/api/bots/${botId}/build/preview?schematicId=${encodeURIComponent(schematicId)}&version=${encodeURIComponent(version)}`);
      setPreview(r);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  }, [schematicId, online, botId, bot?.config.serverId, servers, toast]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const start = async () => {
    if (!schematicId) {
      toast("error", "Şema seçin");
      return;
    }
    try {
      await api.post(`/api/bots/${botId}/action`, {
        type: "build-schematic",
        schematicId,
        originMode,
        x,
        y,
        z,
        player: player.trim() || undefined,
        allowPartial
      });
      toast("info", "İnşaat kuyruğa alındı");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    try {
      await api.post(`/api/bots/${botId}/action`, { type: "stop-build" });
      toast("info", "İnşaat durduruldu");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  if (!bot) return null;

  const pct = build.total > 0 ? Math.min(100, Math.round(((build.placed + build.skipped) / build.total) * 100)) : 0;
  const materials = busy || build.materials.length ? build.materials : preview?.materials ?? [];
  const missingCount = materials.filter((m) => m.missing > 0).length;

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-zinc-200">Yapı inşaat</div>
          <p className="text-[11px] text-zinc-500">
            Şemayı seçin, referans noktası verin. Bot scaffold ile yükselip iş bitince geçici blokları kırar.
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            busy
              ? "bg-amber-950/60 text-amber-300"
              : build.phase === "done"
                ? "bg-emerald-950/60 text-emerald-300"
                : build.phase === "failed"
                  ? "bg-red-950/60 text-red-300"
                  : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {PHASE_TR[build.phase]}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Şema
          <select
            value={schematicId}
            onChange={(e) => setSchematicId(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
          >
            <option value="">Seçiniz…</option>
            {schematics.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.blockCount != null ? ` (${s.blockCount} blok)` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Referans (origin)
          <select
            value={originMode}
            onChange={(e) => setOriginMode(e.target.value as typeof originMode)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
          >
            <option value="here">Botun olduğu yer</option>
            <option value="coords">Koordinat</option>
            <option value="player">Oyuncunun konumu</option>
          </select>
        </label>
      </div>

      {originMode === "coords" && (
        <div className="flex flex-wrap gap-2">
          {(["x", "y", "z"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1 text-xs text-zinc-500">
              {k.toUpperCase()}
              <input
                type="number"
                value={k === "x" ? x : k === "y" ? y : z}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (k === "x") setX(n);
                  else if (k === "y") setY(n);
                  else setZ(n);
                }}
                className="mono w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-zinc-200"
              />
            </label>
          ))}
        </div>
      )}

      {originMode === "player" && (
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Oyuncu adı (yakında entity görünür olmalı)
          <input
            value={player}
            onChange={(e) => setPlayer(e.target.value)}
            placeholder="Steve"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
          />
        </label>
      )}

      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
        Eksik malzemeyle de dene (kısmi inşaat)
      </label>

      {/* progress */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
        <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
          <span>{build.label || (preview ? `${preview.blockCount} blok · ${preview.size.w}×${preview.size.h}×${preview.size.l}` : "—")}</span>
          <span className="mono">
            {build.placed + build.skipped}/{build.total || preview?.blockCount || 0}
            {build.scaffoldsPlaced ? ` · scaf ${build.scaffoldsCleared}/${build.scaffoldsPlaced}` : ""}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full transition-all ${busy ? "bg-amber-500" : build.phase === "done" ? "bg-emerald-500" : "bg-indigo-600"}`}
            style={{ width: `${busy || build.total ? pct : 0}%` }}
          />
        </div>
        {build.error && <p className="mt-1 text-[11px] text-red-400">{build.error}</p>}
        {build.origin && (
          <p className="mono mt-1 text-[10px] text-zinc-600">
            origin {build.origin.x}, {build.origin.y}, {build.origin.z}
            {build.schematicName ? ` · ${build.schematicName}` : ""}
          </p>
        )}
      </div>

      {/* materials */}
      <div>
        <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase">
          Malzemeler
          {missingCount > 0 && (
            <span className="rounded-full bg-red-950/50 px-2 py-0.5 text-[10px] font-normal normal-case text-red-300">
              {missingCount} eksik
            </span>
          )}
          <button type="button" onClick={() => void loadPreview()} className="ml-auto text-[10px] font-normal normal-case text-indigo-400 hover:underline">
            Yenile
          </button>
        </div>
        <div className="max-h-40 overflow-y-auto rounded-lg border border-zinc-800">
          {materials.length === 0 ? (
            <p className="p-2 text-[11px] text-zinc-600 italic">Önizleme için bot online + şema seçili olmalı.</p>
          ) : (
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
                <tr>
                  <th className="px-2 py-1">Blok</th>
                  <th className="px-2 py-1 text-right">Gerek</th>
                  <th className="px-2 py-1 text-right">Var</th>
                  <th className="px-2 py-1 text-right">Eksik</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => (
                  <tr key={m.name} className={`border-t border-zinc-800/80 ${m.missing > 0 ? "bg-red-950/20" : ""}`}>
                    <td className="mono px-2 py-0.5 text-zinc-300">{m.name}</td>
                    <td className="mono px-2 py-0.5 text-right text-zinc-400">{m.need}</td>
                    <td className="mono px-2 py-0.5 text-right text-zinc-400">{m.have}</td>
                    <td className={`mono px-2 py-0.5 text-right ${m.missing > 0 ? "text-red-400" : "text-emerald-500"}`}>
                      {m.missing}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!online || busy || !schematicId}
          onClick={() => void start()}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          ▶ İnşa et
        </button>
        <button
          type="button"
          disabled={!busy}
          onClick={() => void stop()}
          className="rounded-lg bg-red-900/50 px-4 py-1.5 text-sm font-medium text-red-200 hover:bg-red-900/70 disabled:opacity-40"
        >
          ■ Durdur
        </button>
        <span className="self-center text-[10px] text-zinc-600">
          Scaffold: {bot.config.movement.scaffoldBlocks.join(", ") || "—"}
        </span>
      </div>
    </div>
  );
}

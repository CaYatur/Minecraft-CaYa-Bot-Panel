import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BuildRuntime } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";
import { BuildAnim } from "./BuildAnim";

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
  failed: 0,
  scaffoldsPlaced: 0,
  scaffoldsCleared: 0,
  materials: [],
  label: "",
  startedAt: null,
  lastBlock: null,
  recentBlocks: [],
  transform: { rotateY: 0, mirrorX: false, mirrorZ: false }
});

/** Bot detay — Yapı sekmesi (şema + transform + animasyonlu ilerleme) */
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
  const [rotateY, setRotateY] = useState<0 | 90 | 180 | 270>(0);
  const [mirrorX, setMirrorX] = useState(false);
  const [mirrorZ, setMirrorZ] = useState(false);
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

  // origin "here" — sadece boştayken bot konumunu yansıt (inşaatta yürüyünce form kaymasın)
  useEffect(() => {
    if (originMode !== "here" || !bot?.runtime.position) return;
    if (busy) return;
    setX(Math.floor(bot.runtime.position.x));
    setY(Math.floor(bot.runtime.position.y));
    setZ(Math.floor(bot.runtime.position.z));
  }, [bot?.runtime.position?.x, bot?.runtime.position?.y, bot?.runtime.position?.z, originMode, busy]);

  const loadPreview = useCallback(async () => {
    if (!schematicId || !online) {
      setPreview(null);
      return;
    }
    try {
      const server = servers.find((s) => s.id === bot?.config.serverId);
      const version = server?.version && server.version !== "auto" ? server.version : "1.20.4";
      const q = new URLSearchParams({
        schematicId,
        version,
        rotateY: String(rotateY),
        mirrorX: mirrorX ? "1" : "0",
        mirrorZ: mirrorZ ? "1" : "0"
      });
      const r = await api.get<{
        materials: Array<{ name: string; need: number; have: number; missing: number }>;
        blockCount: number;
        size: { w: number; h: number; l: number };
      }>(`/api/bots/${botId}/build/preview?${q}`);
      setPreview(r);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  }, [schematicId, online, botId, bot?.config.serverId, servers, toast, rotateY, mirrorX, mirrorZ]);

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
        allowPartial,
        rotateY,
        mirrorX,
        mirrorZ
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

  const materials = busy || build.materials.length ? build.materials : preview?.materials ?? [];
  const missingCount = materials.filter((m) => m.missing > 0).length;
  const selectedMeta = schematics.find((s) => s.id === schematicId);

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-zinc-200">Yapı inşaat</div>
          <p className="text-[11px] text-zinc-500">
            .schem · .litematic · .caya.json — döndür/aynala, scaffold temizliği, canlı blok animasyonu.
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

      <BuildAnim build={build} />

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
                {s.blockCount != null ? ` (${s.blockCount})` : ""} · {s.format}
              </option>
            ))}
          </select>
          {selectedMeta && (
            <span className="mono text-[10px] text-zinc-600">
              {selectedMeta.width}×{selectedMeta.height}×{selectedMeta.length} · {selectedMeta.format}
            </span>
          )}
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

      {/* transform */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
        <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">Döndür / Aynala</span>
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          Y°
          <select
            value={rotateY}
            onChange={(e) => setRotateY(Number(e.target.value) as 0 | 90 | 180 | 270)}
            className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-zinc-200"
          >
            <option value={0}>0°</option>
            <option value={90}>90°</option>
            <option value={180}>180°</option>
            <option value={270}>270°</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-300">
          <input type="checkbox" checked={mirrorX} onChange={(e) => setMirrorX(e.target.checked)} />
          Ayna X
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-300">
          <input type="checkbox" checked={mirrorZ} onChange={(e) => setMirrorZ(e.target.checked)} />
          Ayna Z
        </label>
        {preview && (
          <span className="mono ml-auto text-[10px] text-zinc-500">
            önizleme {preview.size.w}×{preview.size.h}×{preview.size.l} · {preview.blockCount} blok
          </span>
        )}
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

      {build.error && <p className="text-[11px] text-red-400">{build.error}</p>}
      {build.origin && (
        <p className="mono text-[10px] text-zinc-600">
          origin {build.origin.x}, {build.origin.y}, {build.origin.z}
          {build.schematicName ? ` · ${build.schematicName}` : ""}
          {build.transform
            ? ` · R${build.transform.rotateY}${build.transform.mirrorX ? " mX" : ""}${build.transform.mirrorZ ? " mZ" : ""}`
            : ""}
        </p>
      )}

      <div>
        <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase">
          Malzemeler
          {missingCount > 0 && (
            <span className="rounded-full bg-red-950/50 px-2 py-0.5 text-[10px] font-normal normal-case text-red-300">
              {missingCount} eksik
            </span>
          )}
          <button
            type="button"
            onClick={() => void loadPreview()}
            className="ml-auto text-[10px] font-normal normal-case text-indigo-400 hover:underline"
          >
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

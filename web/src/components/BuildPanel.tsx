import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
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

const PHASE_KEYS: Record<BuildRuntime["phase"], string> = {
  idle: "build.phases.idle",
  preparing: "build.phases.preparing",
  acquiring: "build.phases.acquiring",
  building: "build.phases.building",
  cleanup: "build.phases.cleanup",
  done: "build.phases.done",
  failed: "build.phases.failed",
  cancelled: "build.phases.cancelled"
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
  transform: { rotateY: 0, mirrorX: false, mirrorZ: false },
  placeOrder: "nearby-first",
  collectMissing: false,
  activity: null,
  activityMaterial: null
});

/** Bot detay — Yapı sekmesi (şema + transform + animasyonlu ilerleme) */
export function BuildPanel({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots[botId]);
  const toast = useAppStore((s) => s.toast);
  const servers = useAppStore((s) => s.servers);
  const { t } = useI18n();
  const [schematics, setSchematics] = useState<SchematicMeta[]>([]);
  const [schematicId, setSchematicId] = useState("");
  const [originMode, setOriginMode] = useState<"here" | "coords" | "player">("here");
  const [x, setX] = useState(0);
  const [y, setY] = useState(64);
  const [z, setZ] = useState(0);
  const [player, setPlayer] = useState("");
  const [allowPartial, setAllowPartial] = useState(false);
  const [collectMissing, setCollectMissing] = useState(true);
  const [placeOrder, setPlaceOrder] = useState<"nearby-first" | "layer-first">("nearby-first");
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
  const busy =
    build.phase === "preparing" ||
    build.phase === "acquiring" ||
    build.phase === "building" ||
    build.phase === "cleanup";

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
        collectMissing,
        placeOrder,
        rotateY,
        mirrorX,
        mirrorZ
      });
      toast("info", collectMissing ? "Malzeme toplama + inşaat kuyruğa alındı" : "İnşaat kuyruğa alındı");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const collectOnly = async () => {
    if (!schematicId) {
      toast("error", "Şema seçin");
      return;
    }
    try {
      await api.post(`/api/bots/${botId}/action`, {
        type: "collect-build-materials",
        schematicId,
        rotateY,
        mirrorX,
        mirrorZ
      });
      toast("info", "Eksik malzeme toplama kuyruğa alındı");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    try {
      await api.post(`/api/bots/${botId}/action`, { type: "stop-build" });
      toast("info", t("build.stopped"));
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
          <div className="text-sm font-semibold text-zinc-200">{t("build.title")}</div>
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
          {t(PHASE_KEYS[build.phase])}
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
        <input type="checkbox" checked={collectMissing} onChange={(e) => setCollectMissing(e.target.checked)} />
        Önce eksik malzemeleri topla (yakın → çevre ara)
      </label>
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
        Eksik malzemeyle de dene (kısmi inşaat)
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Yerleştirme sırası
        <select
          value={placeOrder}
          onChange={(e) => setPlaceOrder(e.target.value as "nearby-first" | "layer-first")}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        >
          <option value="nearby-first">Önce yakındakiler / envanterde olanlar (önerilen)</option>
          <option value="layer-first">Katman sırası (serpentine mesafe)</option>
        </select>
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

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!online || busy || !schematicId}
          onClick={() => void start()}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {t("build.start")}
        </button>
        <button
          type="button"
          disabled={!online || busy || !schematicId || missingCount === 0}
          onClick={() => void collectOnly()}
          className="rounded-lg bg-emerald-900/50 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-900/70 disabled:opacity-40"
        >
          Eksikleri topla
        </button>
        <button
          type="button"
          disabled={!busy}
          onClick={() => void stop()}
          className="rounded-lg bg-red-900/50 px-4 py-1.5 text-sm font-medium text-red-200 hover:bg-red-900/70 disabled:opacity-40"
        >
          {t("build.stop")}
        </button>
        <span className="self-center text-[10px] text-zinc-600">
          Scaffold: {bot.config.movement.scaffoldBlocks.join(", ") || "—"}
        </span>
      </div>

      {/* Anlık iş + malzeme listesi — butonların altında, scroll ile taşmaz */}
      {(busy || build.activity) && (
        <div className="rounded-lg border border-amber-900/40 bg-amber-950/25 px-3 py-2">
          <div className="text-[10px] font-semibold tracking-wide text-amber-500/90 uppercase">{t("build.now")}</div>
          <p className="mt-0.5 break-words text-sm text-amber-100">
            {build.activity || build.label || t(PHASE_KEYS[build.phase])}
          </p>
          {build.activityMaterial && (
            <p className="mono mt-0.5 text-[10px] text-amber-600/90">malzeme: {build.activityMaterial}</p>
          )}
        </div>
      )}

      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-zinc-500 uppercase">
          {t("build.materials")}
          {missingCount > 0 && (
            <span className="rounded-full bg-red-950/50 px-2 py-0.5 text-[10px] font-normal normal-case text-red-300">
              {t("build.missing", { n: missingCount })}
            </span>
          )}
          {(busy || Boolean(build.activity)) && (
            <span className="inline-flex items-center gap-1 text-[10px] font-normal normal-case text-emerald-500/90">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              {t("build.live")}
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
        <div className="max-h-52 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border border-zinc-800">
          {materials.length === 0 ? (
            <p className="p-2 text-[11px] text-zinc-600 italic">Önizleme için bot online + şema seçili olmalı.</p>
          ) : (
            <table className="w-full table-fixed text-left text-[11px]">
              <thead className="sticky top-0 z-10 bg-zinc-900 text-zinc-500">
                <tr>
                  <th className="w-[46%] px-2 py-1">Blok</th>
                  <th className="w-[18%] px-2 py-1 text-right">Gerek</th>
                  <th className="w-[18%] px-2 py-1 text-right">Var</th>
                  <th className="w-[18%] px-2 py-1 text-right">Eksik</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => {
                  const active = build.activityMaterial === m.name;
                  return (
                    <tr
                      key={m.name}
                      className={`border-t border-zinc-800/80 ${
                        active
                          ? "bg-amber-950/40 ring-1 ring-inset ring-amber-700/50"
                          : m.missing > 0
                            ? "bg-red-950/20"
                            : m.have >= m.need
                              ? "bg-emerald-950/15"
                              : ""
                      }`}
                    >
                      <td className="mono truncate px-2 py-0.5 text-zinc-300" title={m.name}>
                        {active ? "▸ " : ""}
                        {m.name}
                      </td>
                      <td className="mono px-2 py-0.5 text-right text-zinc-400 tabular-nums">{m.need}</td>
                      <td className="mono px-2 py-0.5 text-right text-zinc-200 tabular-nums">{m.have}</td>
                      <td
                        className={`mono px-2 py-0.5 text-right tabular-nums ${
                          m.missing > 0 ? "text-red-400" : "text-emerald-500"
                        }`}
                      >
                        {m.missing}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

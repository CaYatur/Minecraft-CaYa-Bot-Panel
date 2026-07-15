import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { loadParsedSchematic, materialCounts } from "./library";
import { placeBlockAt } from "./place";
import { ScaffoldTracker } from "./scaffold";
import {
  emptyBuildRuntime,
  type BuildOrigin,
  type BuildRuntime,
  type MaterialNeed,
  type SchematicBlock
} from "./types";

/**
 * Faz 14 — Şema inşaat servisi.
 * Yerleştirme + scaffold defteri + malzeme raporu + progress emit.
 */
export class BuildService {
  private runtime: BuildRuntime = emptyBuildRuntime();
  private scaffolds = new ScaffoldTracker();
  private activeTaskId: string | null = null;

  constructor(private readonly instance: BotInstance) {}

  getRuntime(): BuildRuntime {
    return {
      ...this.runtime,
      materials: this.runtime.materials.map((m) => ({ ...m })),
      origin: this.runtime.origin ? { ...this.runtime.origin } : null
    };
  }

  private emit() {
    this.instance.emit("build", { botId: this.instance.config.id, build: this.getRuntime() });
  }

  private log() {
    return this.instance.getLogger();
  }

  private setPhase(phase: BuildRuntime["phase"], label?: string, error?: string) {
    this.runtime.phase = phase;
    if (label != null) this.runtime.label = label;
    if (error != null) this.runtime.error = error;
    this.emit();
  }

  /** Envantere göre malzeme tablosu */
  materialsFor(blocks: SchematicBlock[]): MaterialNeed[] {
    const needMap = materialCounts(blocks);
    const bot = this.instance.bot;
    const haveMap: Record<string, number> = {};
    if (bot) {
      for (const it of bot.inventory.items()) {
        haveMap[it.name] = (haveMap[it.name] ?? 0) + it.count;
      }
    }
    return Object.entries(needMap)
      .map(([name, need]) => {
        const have = haveMap[name] ?? 0;
        return { name, need, have, missing: Math.max(0, need - have) };
      })
      .sort((a, b) => b.missing - a.missing || a.name.localeCompare(b.name));
  }

  async previewMaterials(schematicId: string, versionHint?: string) {
    const parsed = await loadParsedSchematic(schematicId, versionHint);
    return {
      meta: parsed.meta,
      materials: this.materialsFor(parsed.blocks),
      blockCount: parsed.blocks.length,
      size: { w: parsed.width, h: parsed.height, l: parsed.length }
    };
  }

  stopBuild(reason = "inşaat durduruldu") {
    this.runtime.phase = this.runtime.phase === "idle" ? "idle" : "cancelled";
    this.runtime.label = reason;
    this.runtime.error = reason;
    // cancel build tasks
    const cur = this.instance.tasks.currentSummary;
    if (cur?.type === "build") this.instance.tasks.cancel(cur.id, reason);
    for (const t of this.instance.tasks.queueSummaries) {
      if (t.type === "build") this.instance.tasks.cancel(t.id, reason);
    }
    this.emit();
    this.log().info("İnşaat durduruldu", reason);
  }

  enqueueBuild(opts: {
    schematicId: string;
    origin: BuildOrigin;
    /** malzeme eksikse yine de dene */
    allowPartial?: boolean;
    versionHint?: string;
  }) {
    const sid = opts.schematicId.trim();
    if (!sid) throw new Error("Şema id gerekli");

    // önceki build iptal
    this.stopBuild("yeni inşaat başlıyor");
    this.scaffolds.clear();
    this.runtime = emptyBuildRuntime();
    this.runtime.phase = "preparing";
    this.runtime.schematicId = sid;
    this.runtime.startedAt = Date.now();
    this.runtime.label = "hazırlanıyor…";
    this.emit();

    const summary = this.instance.tasks.enqueue(
      {
        type: "build",
        label: `yapı: ${sid.slice(0, 8)}…`,
        priority: PRIORITY.USER,
        params: { ...opts },
        requeueOnPreempt: false
      },
      () => (token, report) => this.runBuild(opts, token, report)
    );
    this.activeTaskId = summary.id;
    return summary;
  }

  private resolveOrigin(origin: BuildOrigin): { x: number; y: number; z: number } {
    const bot = this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot çevrimdışı");

    if (origin.mode === "here") {
      return {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z)
      };
    }
    if (origin.mode === "player") {
      const name = String(origin.player ?? "").trim();
      if (!name) throw new Error("Oyuncu adı gerekli");
      const ent = bot.players[name]?.entity;
      if (!ent) {
        const inTab = Boolean(bot.players[name]);
        throw new Error(
          inTab
            ? `${name} menzil dışında — konum bilinmiyor (yakınlaşın)`
            : `${name} sunucuda görünmüyor`
        );
      }
      return {
        x: Math.floor(ent.position.x),
        y: Math.floor(ent.position.y),
        z: Math.floor(ent.position.z)
      };
    }
    // coords
    if (origin.x == null || origin.y == null || origin.z == null) {
      throw new Error("Koordinat origin için x,y,z gerekli");
    }
    return {
      x: Math.floor(Number(origin.x)),
      y: Math.floor(Number(origin.y)),
      z: Math.floor(Number(origin.z))
    };
  }

  private sortBlocks(blocks: SchematicBlock[]): SchematicBlock[] {
    // alt katman önce, sonra z, sonra x — destekli inşaat
    return [...blocks].sort((a, b) => a.dy - b.dy || a.dz - b.dz || a.dx - b.dx);
  }

  private async runBuild(
    opts: {
      schematicId: string;
      origin: BuildOrigin;
      allowPartial?: boolean;
      versionHint?: string;
    },
    token: TaskToken,
    report: ProgressFn
  ) {
    const version =
      opts.versionHint ||
      (() => {
        // sunucu sürümü bot üzerinden bilinmeyebilir — default
        return "1.20.4";
      })();

    try {
      this.setPhase("preparing", "şema yükleniyor…");
      const parsed = await loadParsedSchematic(opts.schematicId, version);
      this.runtime.schematicName = parsed.meta.name;
      const blocks = this.sortBlocks(parsed.blocks);
      this.runtime.total = blocks.length;
      this.runtime.materials = this.materialsFor(blocks);
      this.emit();

      const missing = this.runtime.materials.filter((m) => m.missing > 0);
      if (missing.length && !opts.allowPartial) {
        const msg = `Eksik malzeme: ${missing
          .slice(0, 5)
          .map((m) => `${m.name}×${m.missing}`)
          .join(", ")}${missing.length > 5 ? "…" : ""}`;
        this.setPhase("failed", msg, msg);
        this.log().warn("İnşaat başlamadı — eksik malzeme", msg);
        throw new Error(msg + " (allowPartial ile zorla deneyebilirsiniz)");
      }
      if (missing.length) {
        this.log().warn(
          "Eksik malzemeyle kısmi inşaat",
          missing.map((m) => `${m.name}×${m.missing}`).join(", ")
        );
      }

      const origin = this.resolveOrigin(opts.origin);
      this.runtime.origin = origin;
      this.setPhase("building", `inşa: ${parsed.meta.name}`);
      this.log().info(
        `İnşaat başladı: ${parsed.meta.name}`,
        `origin ${origin.x},${origin.y},${origin.z} · ${blocks.length} blok`
      );

      let placed = 0;
      let skipped = 0;
      let failed = 0;

      for (let i = 0; i < blocks.length; i++) {
        if (token.cancelled) throw new Error(token.reason ?? "iptal");
        const b = blocks[i]!;
        const wx = origin.x + b.dx;
        const wy = origin.y + b.dy;
        const wz = origin.z + b.dz;

        report({
          done: i,
          total: blocks.length,
          label: `${b.name} @ ${wx},${wy},${wz}`
        });
        this.runtime.placed = placed;
        this.runtime.skipped = skipped;
        this.runtime.label = `yerleştir: ${b.name} (${i + 1}/${blocks.length})`;
        this.runtime.scaffoldsPlaced = this.scaffolds.count;
        // malzeme anlık
        this.runtime.materials = this.materialsFor(blocks.slice(i));
        this.emit();

        const res = await placeBlockAt(this.instance, wx, wy, wz, b.name, token, this.scaffolds);
        if (res === "placed") placed++;
        else if (res === "skipped") skipped++;
        else failed++;

        this.runtime.placed = placed;
        this.runtime.skipped = skipped;
      }

      // scaffold temizliği
      this.setPhase("cleanup", "geçici bloklar temizleniyor…");
      this.log().info("Scaffold temizliği", `${this.scaffolds.count} kayıt`);
      const cleared = await this.scaffolds.cleanup(this.instance.bot!, token, (c, t) => {
        this.runtime.scaffoldsCleared = c;
        this.runtime.label = `temizlik ${c}/${t}`;
        report({ done: blocks.length, total: blocks.length, label: `scaffold ${c}/${t}` });
        this.emit();
      });
      this.runtime.scaffoldsCleared = cleared;

      if (token.cancelled) {
        this.setPhase("cancelled", "iptal edildi");
        throw new Error(token.reason ?? "iptal");
      }

      const label = `bitti: ${placed} kondu, ${skipped} atlandı, ${failed} başarısız, scaffold ${cleared}`;
      this.runtime.placed = placed;
      this.runtime.skipped = skipped;
      this.runtime.materials = this.materialsFor([]);
      this.setPhase("done", label);
      this.log().success(`İnşaat tamam: ${parsed.meta.name}`, label);
      report({ done: blocks.length, total: blocks.length, label });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // best-effort cleanup
      try {
        if (this.scaffolds.count && this.instance.bot) {
          this.setPhase("cleanup", "iptal — scaffold temizliği…");
          await this.scaffolds.cleanup(this.instance.bot, { cancelled: false });
        }
      } catch {
        /* */
      }
      if (this.runtime.phase !== "failed" && this.runtime.phase !== "cancelled") {
        this.setPhase(token.cancelled ? "cancelled" : "failed", msg, msg);
      }
      this.log().error("İnşaat hata/iptal", msg);
      throw e;
    }
  }

  detach() {
    this.stopBuild("bot koptu");
    this.scaffolds.clear();
    this.runtime = emptyBuildRuntime();
    this.emit();
  }
}

export { listSchematics, getSchematicMeta, deleteSchematic, addSchematicFromBase64, addCayaJsonSchematic, loadParsedSchematic, materialCounts } from "./library";
export type { BuildOrigin, BuildRuntime, MaterialNeed, SchematicMeta, SchematicBlock } from "./types";
export { emptyBuildRuntime } from "./types";

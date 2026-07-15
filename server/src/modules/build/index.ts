import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { shouldSkipBlock } from "./blocks";
import { loadParsedSchematic, materialCounts } from "./library";
import { placeBlockAt } from "./place";
import { ScaffoldTracker } from "./scaffold";
import {
  emptyBuildRuntime,
  type BuildOrigin,
  type BuildPlacedBlock,
  type BuildRuntime,
  type MaterialNeed,
  type SchematicBlock
} from "./types";
import { normalizeRotateY, type BuildTransform, type RotateY } from "./transform";

/**
 * Faz 14–16 — Şema inşaat: schem/litematic/caya + transform + progress + scaffold.
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
      origin: this.runtime.origin ? { ...this.runtime.origin } : null,
      lastBlock: this.runtime.lastBlock ? { ...this.runtime.lastBlock } : null,
      recentBlocks: this.runtime.recentBlocks.map((b) => ({ ...b })),
      transform: { ...this.runtime.transform }
    };
  }

  private lastEmitAt = 0;
  private pendingEmit = false;

  private emit(force = false) {
    const now = Date.now();
    // her blokta 2× socket UI'yi donduruyordu — throttle
    if (!force && now - this.lastEmitAt < 120) {
      this.pendingEmit = true;
      return;
    }
    this.lastEmitAt = now;
    this.pendingEmit = false;
    this.instance.emit("build", { botId: this.instance.config.id, build: this.getRuntime() });
  }

  private flushEmit() {
    if (this.pendingEmit) this.emit(true);
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

  private pushBlockEvent(ev: BuildPlacedBlock) {
    this.runtime.lastBlock = ev;
    this.runtime.recentBlocks = [...this.runtime.recentBlocks.slice(-15), ev];
  }

  materialsFor(blocks: SchematicBlock[]): MaterialNeed[] {
    const needMap = materialCounts(blocks);
    const bot = this.instance.bot;
    const haveMap: Record<string, number> = {};
    if (bot) {
      for (const it of bot.inventory.items()) {
        haveMap[it.name] = (haveMap[it.name] ?? 0) + it.count;
      }
    }
    // water/lava şemada blok adı; envanterde kova
    const aliasHave = (blockName: string): number => {
      if (haveMap[blockName] != null) return haveMap[blockName]!;
      if (blockName === "water" || blockName === "flowing_water") return haveMap["water_bucket"] ?? 0;
      if (blockName === "lava" || blockName === "flowing_lava") return haveMap["lava_bucket"] ?? 0;
      if (blockName === "powder_snow") return haveMap["powder_snow_bucket"] ?? 0;
      if (blockName === "redstone_wire") return haveMap["redstone"] ?? 0;
      return 0;
    };
    return Object.entries(needMap)
      .map(([name, need]) => {
        const have = aliasHave(name);
        return { name, need, have, missing: Math.max(0, need - have) };
      })
      .sort((a, b) => b.missing - a.missing || a.name.localeCompare(b.name));
  }

  async previewMaterials(schematicId: string, versionHint?: string, transform?: BuildTransform) {
    const parsed = await loadParsedSchematic(schematicId, versionHint, transform);
    return {
      meta: parsed.meta,
      materials: this.materialsFor(parsed.blocks),
      blockCount: parsed.blocks.length,
      size: { w: parsed.width, h: parsed.height, l: parsed.length },
      transform: {
        rotateY: normalizeRotateY(transform?.rotateY),
        mirrorX: Boolean(transform?.mirrorX),
        mirrorZ: Boolean(transform?.mirrorZ)
      }
    };
  }

  stopBuild(reason = "inşaat durduruldu") {
    const cur = this.instance.tasks.currentSummary;
    if (cur?.type === "build") this.instance.tasks.cancel(cur.id, reason);
    for (const t of this.instance.tasks.queueSummaries) {
      if (t.type === "build") this.instance.tasks.cancel(t.id, reason);
    }
    // scaffold temizliği best-effort (async, iz bırakma)
    if (this.scaffolds.count && this.instance.bot && this.instance.status === "online") {
      const bot = this.instance.bot;
      const tracker = this.scaffolds;
      this.scaffolds = new ScaffoldTracker();
      void tracker.cleanup(bot, { cancelled: false }).then((n) => {
        this.runtime.scaffoldsCleared += n;
        this.log().info("Durdurma sonrası scaffold temizliği", `${n} blok`);
        this.emit();
      });
    } else {
      this.scaffolds.clear();
    }
    this.runtime.phase = this.runtime.phase === "idle" ? "idle" : "cancelled";
    this.runtime.label = reason;
    this.runtime.error = reason;
    this.emit();
    this.log().info("İnşaat durduruldu", reason);
  }

  enqueueBuild(opts: {
    schematicId: string;
    origin: BuildOrigin;
    allowPartial?: boolean;
    versionHint?: string;
    rotateY?: RotateY | number;
    mirrorX?: boolean;
    mirrorZ?: boolean;
  }) {
    const sid = opts.schematicId.trim();
    if (!sid) throw new Error("Şema id gerekli");

    this.stopBuild("yeni inşaat başlıyor");
    this.scaffolds = new ScaffoldTracker();
    this.runtime = emptyBuildRuntime();
    this.runtime.phase = "preparing";
    this.runtime.schematicId = sid;
    this.runtime.startedAt = Date.now();
    this.runtime.label = "hazırlanıyor…";
    this.runtime.transform = {
      rotateY: normalizeRotateY(opts.rotateY),
      mirrorX: Boolean(opts.mirrorX),
      mirrorZ: Boolean(opts.mirrorZ)
    };
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
          inTab ? `${name} menzil dışında — konum bilinmiyor (yakınlaşın)` : `${name} sunucuda görünmüyor`
        );
      }
      return {
        x: Math.floor(ent.position.x),
        y: Math.floor(ent.position.y),
        z: Math.floor(ent.position.z)
      };
    }
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
    return [...blocks].sort((a, b) => a.dy - b.dy || a.dz - b.dz || a.dx - b.dx);
  }

  private async runBuild(
    opts: {
      schematicId: string;
      origin: BuildOrigin;
      allowPartial?: boolean;
      versionHint?: string;
      rotateY?: RotateY | number;
      mirrorX?: boolean;
      mirrorZ?: boolean;
    },
    token: TaskToken,
    report: ProgressFn
  ) {
    const version = opts.versionHint || "1.20.4";
    const transform: BuildTransform = {
      rotateY: normalizeRotateY(opts.rotateY),
      mirrorX: Boolean(opts.mirrorX),
      mirrorZ: Boolean(opts.mirrorZ)
    };
    this.runtime.transform = {
      rotateY: transform.rotateY ?? 0,
      mirrorX: Boolean(transform.mirrorX),
      mirrorZ: Boolean(transform.mirrorZ)
    };

    try {
      this.setPhase("preparing", "şema yükleniyor…");
      const parsed = await loadParsedSchematic(opts.schematicId, version, transform);
      this.runtime.schematicName = parsed.meta.name;
      // üst yarı / portal vb. atla
      const blocks = this.sortBlocks(
        parsed.blocks.filter((b) => !shouldSkipBlock(b.name, b.properties))
      );
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

      const origin = this.resolveOrigin(opts.origin);
      this.runtime.origin = origin;
      const rotLabel =
        transform.rotateY || transform.mirrorX || transform.mirrorZ
          ? ` · R${transform.rotateY ?? 0}${transform.mirrorX ? " mX" : ""}${transform.mirrorZ ? " mZ" : ""}`
          : "";
      this.setPhase("building", `inşa: ${parsed.meta.name}${rotLabel}`);
      this.log().info(
        `İnşaat başladı: ${parsed.meta.name}`,
        `origin ${origin.x},${origin.y},${origin.z} · ${blocks.length} blok${rotLabel}`
      );

      let placed = 0;
      let skipped = 0;
      let failed = 0;
      let consecutiveFail = 0;
      // malzeme özeti her blokta değil — arada bir
      this.runtime.materials = this.materialsFor(blocks);

      for (let i = 0; i < blocks.length; i++) {
        if (token.cancelled) throw new Error(token.reason ?? "iptal");
        const b = blocks[i]!;
        const wx = origin.x + b.dx;
        const wy = origin.y + b.dy;
        const wz = origin.z + b.dz;

        const skipReason = shouldSkipBlock(b.name, b.properties);
        let res: "placed" | "skipped" | "failed";
        if (skipReason) {
          res = "skipped";
        } else {
          res = await placeBlockAt(this.instance, wx, wy, wz, b.name, token, this.scaffolds, { retries: 1 });
        }
        if (res === "placed") {
          this.scaffolds.protectStructure(wx, wy, wz);
          consecutiveFail = 0;
        }

        if (res === "placed") placed++;
        else if (res === "skipped") {
          skipped++;
          consecutiveFail = 0;
        } else {
          failed++;
          consecutiveFail++;
        }

        const ev: BuildPlacedBlock = {
          name: b.name,
          x: wx,
          y: wy,
          z: wz,
          status: res,
          t: Date.now()
        };
        this.pushBlockEvent(ev);

        this.runtime.placed = placed;
        this.runtime.skipped = skipped;
        this.runtime.failed = failed;
        this.runtime.scaffoldsPlaced = this.scaffolds.count;
        this.runtime.label = `${b.name} · ${i + 1}/${blocks.length} · +${placed} / atla ${skipped} / hata ${failed}`;

        // görev paneli + UI (throttled)
        if (i % 3 === 0 || res === "placed" || i === blocks.length - 1) {
          report({ done: i + 1, total: blocks.length, label: this.runtime.label });
        }
        if (i % 8 === 0) {
          this.runtime.materials = this.materialsFor(blocks.slice(i + 1));
        }
        this.emit(i === 0 || i === blocks.length - 1 || res === "failed");

        // peş peşe çok hata → kısa mola (path kilitlenmesi)
        if (consecutiveFail >= 5) {
          this.runtime.label = `yol sorunu — kısa bekleme (${consecutiveFail} hata)`;
          this.emit(true);
          try {
            this.instance.bot?.pathfinder?.setGoal(null);
          } catch {
            /* */
          }
          await new Promise((r) => setTimeout(r, 400));
          consecutiveFail = 0;
        }
      }

      this.flushEmit();
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
      this.runtime.materials = this.materialsFor([]);
      this.setPhase("done", label);
      this.log().success(`İnşaat tamam: ${parsed.meta.name}`, label);
      report({ done: blocks.length, total: blocks.length, label });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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

export {
  listSchematics,
  getSchematicMeta,
  deleteSchematic,
  addSchematicFromBase64,
  addCayaJsonSchematic,
  loadParsedSchematic,
  materialCounts
} from "./library";
export type { BuildOrigin, BuildRuntime, MaterialNeed, SchematicMeta, SchematicBlock, BuildPlacedBlock } from "./types";
export { emptyBuildRuntime } from "./types";
export type { BuildTransform, RotateY } from "./transform";

import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { shouldSkipBlock } from "./blocks";
import { loadParsedSchematic, materialCounts } from "./library";
import { distToBlock, itemNameForBlock, pathNear, placeBlockAt, PLACE_REACH } from "./place";
// caya-build-resource-storage-v1: build
import { withdrawBuildMaterials } from "./storage";
import { ScaffoldTracker } from "./scaffold";
import {
  emptyBuildRuntime,
  type BuildOrigin,
  type BuildPlaceOrder,
  type BuildPlacedBlock,
  type BuildRuntime,
  type MaterialNeed,
  type SchematicBlock
} from "./types";
import { normalizeRotateY, type BuildTransform, type RotateY } from "./transform";
import { v3 } from "./vec3util";

/**
 * Faz 14–16 — Schematic inşaat: schem/litematic/caya + transform + progress + scaffold.
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
    this.emit(true);
  }

  private setActivity(text: string | null, material?: string | null) {
    this.runtime.activity = text;
    this.runtime.activityMaterial = material ?? null;
    if (text) this.runtime.label = text;
    this.emit(true);
  }

  /** Malzeme listesini inventoryden anlık yenile + UI'ye bas */
  private refreshMaterials(blocks: SchematicBlock[], force = true) {
    this.runtime.materials = this.materialsFor(blocks);
    this.emit(force);
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
    const aliasHave = (blockName: string): number => {
      // Aynı blok for kullanılabilen farklı item stack'lerini topla; max almak tabloyu eksik gösteriyordu.
      const names = new Set([...itemNameForBlock(blockName), blockName]);
      let total = 0;
      for (const name of names) total += haveMap[name] ?? 0;
      return total;
    };
    return Object.entries(needMap)
      .map(([name, need]) => {
        const have = aliasHave(name);
        return { name, need, have, missing: Math.max(0, need - have) };
      })
      .sort((a, b) => b.missing - a.missing || a.name.localeCompare(b.name));
  }

  private countHaveItem(itemNames: string[]): number {
    const bot = this.instance.bot;
    if (!bot) return 0;
    let n = 0;
    for (const it of bot.inventory.items()) {
      if (itemNames.includes(it.name)) n += it.count;
    }
    return n;
  }

  private hasItemForBlock(blockName: string): boolean {
    return this.countHaveItem(itemNameForBlock(blockName)) > 0;
  }

  /**
   * Eksik malzemeleri kaynak kuyruğuna ekle (sırayla USER görevleri).
   * 1) yere düşenler  2) her eksik tür for collect/mine (yakın → halka arama)
   */
  enqueueCollectMissing(opts: { schematicId: string; versionHint?: string; transform?: BuildTransform }) {
    const sid = opts.schematicId.trim();
    if (!sid) throw new Error("Schematic id required");
    const version = opts.versionHint || "1.20.4";

    return this.instance.tasks.enqueue(
      {
        type: "build-acquire",
        label: `eksik malzeme: ${sid.slice(0, 8)}…`,
        priority: PRIORITY.USER,
        params: { schematicId: sid },
        requeueOnPreempt: true
      },
      () => async (token, report) => {
        this.setActivity("Preparing material list…");
        this.setPhase("acquiring", "malzeme listesi…");
        report({ done: 0, total: 1, label: "malzeme listesi…" });
        const parsed = await loadParsedSchematic(sid, version, opts.transform);
        const blocks = parsed.blocks.filter((b) => !shouldSkipBlock(b.name, b.properties));
        this.refreshMaterials(blocks, true);

        try {
          this.setActivity("Picking up dropped items…", null);
          report({ done: 0, total: 1, label: "drops…" });
          await this.instance.gather.runCollectDrops(undefined, 28, token, (p) => {
            report(p);
            this.setActivity(p.label ?? "Drops…", null);
            this.refreshMaterials(blocks, true);
          });
        } catch {
          /* best-effort */
        }
        this.refreshMaterials(blocks, true);

        const missing = this.materialsFor(blocks).filter((m) => m.missing > 0);
        if (!missing.length) {
          this.setActivity(null, null);
          this.setPhase("idle", "eksik malzeme yok");
          report({ done: 1, total: 1, label: "eksik yok" });
          return;
        }

        let i = 0;
        for (const m of missing) {
          if (token.cancelled) throw new Error(token.reason ?? "cancelled");
          i++;
          this.setActivity(`Collecting: ${m.name} ×${m.missing} (${i}/${missing.length})`, m.name);
          report({ done: i - 1, total: missing.length, label: `topla ${m.name} ×${m.missing}` });
          try {
            await this.acquireOneMaterial(m.name, m.missing, token, report, blocks);
          } catch (e) {
            this.log().warn(`Could not collect material: ${m.name}`, e instanceof Error ? e.message : String(e));
            this.setActivity(`Failed: ${m.name} — ${e instanceof Error ? e.message : String(e)}`, m.name);
          }
          this.refreshMaterials(blocks, true);
        }

        const still = this.materialsFor(blocks).filter((m) => m.missing > 0);
        this.refreshMaterials(blocks, true);
        this.setActivity(null, null);
        const label =
          still.length === 0
            ? "malzemeler tamam"
            : `partial: still missing ${still
                .slice(0, 4)
                .map((m) => `${m.name}×${m.missing}`)
                .join(", ")}`;
        this.setPhase(still.length === 0 ? "idle" : "failed", label, still.length ? label : undefined);
        report({ done: missing.length, total: missing.length, label });
        this.log().info("Eksik malzeme toplama bitti", label);
      }
    );
  }

  /** Tek malzeme: drop → chest/shulker → craft zinciri → doğrudan kaynak */
  private async acquireOneMaterial(
    blockName: string,
    count: number,
    token: TaskToken,
    report: ProgressFn,
    allBlocks: SchematicBlock[]
  ) {
    const names = itemNameForBlock(blockName);
    const item = names[0] ?? blockName;
    const additional = Math.max(1, Math.floor(count));
    const targetHave = this.countHaveItem(names) + additional;
    const refresh = (label: string) => {
      this.runtime.activity = label;
      this.runtime.activityMaterial = blockName;
      this.runtime.label = label;
      this.refreshMaterials(allBlocks, true);
      report({ done: Math.min(this.countHaveItem(names), targetHave), total: targetHave, label });
    };

    // 1) Yakındaki düşmüş item'ler.
    try {
      refresh(`Searching ground: ${item}`);
      await this.instance.gather.runCollectDrops(item, 16, token, (p) => refresh(p.label ?? `Yerde: ${item}`));
    } catch { /* best effort */ }
    if (this.countHaveItem(names) >= targetHave) return;

    // 2) Oyuncunun chest/barrel/worlddaki shulker'ı; gerekirse botun taşıdığı shulker.
    const storageNeed = targetHave - this.countHaveItem(names);
    await withdrawBuildMaterials(this.instance, names, storageNeed, token, refresh);
    if (this.countHaveItem(names) >= targetHave) return;

    // 3) Tarif bağımlılıklarını çöz: örn. dark_oak_fence → dark_oak_planks → dark_oak_log.
    if (this.instance.craft.canCraft(item)) {
      try {
        refresh(`Craft zinciri: ${item} · target ${targetHave}`);
        await this.instance.craft.runCraftInline(item, targetHave, token, (p) => refresh(p.label ?? `Craft: ${item}`));
      } catch (error) {
        this.log().warn(`Craft chain incomplete: ${item}`, error instanceof Error ? error.message : String(error));
      }
    }
    if (this.countHaveItem(names) >= targetHave) return;

    // 4) Son çare: kesin isimli doğal blok/maden araması. Plank gibi sonuçlar aynı ağaç türüne yönlendirilir.
    refresh(`Searching resource: ${item} · target ${targetHave}`);
    await this.instance.gather.runCollectBlock(item, targetHave, token, (p) => refresh(p.label ?? `Collecting: ${item}`));

    // Kaynak toplama ham girdiyi getirdiyse bir kez daha craft et.
    if (this.countHaveItem(names) < targetHave && this.instance.craft.canCraft(item)) {
      await this.instance.craft.runCraftInline(item, targetHave, token, (p) => refresh(p.label ?? `Craft: ${item}`));
    }
    this.refreshMaterials(allBlocks, true);
    if (this.countHaveItem(names) < targetHave) {
      throw new Error(`${item}: target ${targetHave}, bulunan ${this.countHaveItem(names)}`);
    }
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

  stopBuild(reason = "build stopped") {
    const buildTypes = new Set(["build", "build-acquire", "build-acquire-plan"]);
    const cur = this.instance.tasks.currentSummary;
    if (cur && buildTypes.has(cur.type)) this.instance.tasks.cancel(cur.id, reason);
    for (const t of this.instance.tasks.queueSummaries) {
      if (buildTypes.has(t.type)) this.instance.tasks.cancel(t.id, reason);
    }
    // scaffold temizliği best-effort (async, iz dropma)
    if (this.scaffolds.count && this.instance.bot && this.instance.status === "online") {
      const bot = this.instance.bot;
      const tracker = this.scaffolds;
      this.scaffolds = new ScaffoldTracker();
      void tracker.cleanup(bot, { cancelled: false }).then((n) => {
        this.runtime.scaffoldsCleared += n;
        this.log().info("Scaffold cleanup after stop", `${n} blok`);
        this.emit();
      });
    } else {
      this.scaffolds.clear();
    }
    this.runtime.phase = this.runtime.phase === "idle" ? "idle" : "cancelled";
    this.runtime.label = reason;
    this.runtime.error = reason;
    this.runtime.activity = null;
    this.runtime.activityMaterial = null;
    this.emit();
    this.log().info("Build stopped", reason);
  }

  /** Tüm iş sıfırla: inşaat runtime + scaffold tamamen temiz (bot bağlı kalır) */
  hardReset(reason = "build reset") {
    this.stopBuild(reason);
    this.scaffolds = new ScaffoldTracker();
    this.runtime = emptyBuildRuntime();
    this.runtime.label = reason;
    this.emit(true);
  }

  enqueueBuild(opts: {
    schematicId: string;
    origin: BuildOrigin;
    allowPartial?: boolean;
    /** eksik malzemeleri önce kuyruğa al (kaynak görevleri + inşaat) */
    collectMissing?: boolean;
    /** nearby-first: inventoryde olan/yakın önce; layer-first: serpentine */
    placeOrder?: BuildPlaceOrder;
    versionHint?: string;
    rotateY?: RotateY | number;
    mirrorX?: boolean;
    mirrorZ?: boolean;
  }) {
    const sid = opts.schematicId.trim();
    if (!sid) throw new Error("Schematic id required");

    this.stopBuild("starting new build");
    this.scaffolds = new ScaffoldTracker();
    this.runtime = emptyBuildRuntime();
    this.runtime.phase = "preparing";
    this.runtime.schematicId = sid;
    this.runtime.startedAt = Date.now();
    this.runtime.label = "preparing…";
    this.runtime.collectMissing = Boolean(opts.collectMissing);
    this.runtime.placeOrder = opts.placeOrder === "layer-first" ? "layer-first" : "nearby-first";
    this.runtime.transform = {
      rotateY: normalizeRotateY(opts.rotateY),
      mirrorX: Boolean(opts.mirrorX),
      mirrorZ: Boolean(opts.mirrorZ)
    };
    this.emit();

    const transform: BuildTransform = {
      rotateY: normalizeRotateY(opts.rotateY),
      mirrorX: Boolean(opts.mirrorX),
      mirrorZ: Boolean(opts.mirrorZ)
    };

    const summary = this.instance.tasks.enqueue(
      {
        type: "build",
        label: `build: ${sid.slice(0, 8)}…`,
        priority: PRIORITY.USER,
        params: { ...opts },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runBuild(opts, token, report)
    );
    this.activeTaskId = summary.id;
    return summary;
  }

  private resolveOrigin(origin: BuildOrigin): { x: number; y: number; z: number } {
    const bot = this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot offline");

    if (origin.mode === "here") {
      return {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z)
      };
    }
    if (origin.mode === "player") {
      const name = String(origin.player ?? "").trim();
      if (!name) throw new Error("Player name required");
      const ent = bot.players[name]?.entity;
      if (!ent) {
        const inTab = Boolean(bot.players[name]);
        throw new Error(
          inTab ? `${name} out of range — position unknown (get closer)` : `${name} not visible on server`
        );
      }
      return {
        x: Math.floor(ent.position.x),
        y: Math.floor(ent.position.y),
        z: Math.floor(ent.position.z)
      };
    }
    if (origin.x == null || origin.y == null || origin.z == null) {
      throw new Error("x,y,z required for coordinate origin");
    }
    return {
      x: Math.floor(Number(origin.x)),
      y: Math.floor(Number(origin.y)),
      z: Math.floor(Number(origin.z))
    };
  }

  /** Katman katman, her katmanda yılan yolu (yürürken place for) */
  private sortBlocks(blocks: SchematicBlock[]): SchematicBlock[] {
    const byY = new Map<number, SchematicBlock[]>();
    for (const b of blocks) {
      const list = byY.get(b.dy) ?? [];
      list.push(b);
      byY.set(b.dy, list);
    }
    const ys = [...byY.keys()].sort((a, b) => a - b);
    const out: SchematicBlock[] = [];
    for (const y of ys) {
      const layer = byY.get(y)!;
      // z satırları, her satırda x; çift z ters x (serpentine)
      layer.sort((a, b) => a.dz - b.dz || a.dx - b.dx);
      const rows = new Map<number, SchematicBlock[]>();
      for (const b of layer) {
        const r = rows.get(b.dz) ?? [];
        r.push(b);
        rows.set(b.dz, r);
      }
      const zs = [...rows.keys()].sort((a, b) => a - b);
      let flip = false;
      for (const z of zs) {
        const row = rows.get(z)!;
        row.sort((a, b) => (flip ? b.dx - a.dx : a.dx - b.dx));
        out.push(...row);
        flip = !flip;
      }
    }
    return out;
  }

  private async runBuild(
    opts: {
      schematicId: string;
      origin: BuildOrigin;
      allowPartial?: boolean;
      collectMissing?: boolean;
      placeOrder?: BuildPlaceOrder;
      versionHint?: string;
      rotateY?: RotateY | number;
      mirrorX?: boolean;
      mirrorZ?: boolean;
    },
    token: TaskToken,
    report: ProgressFn
  ) {
    const version = opts.versionHint || "1.20.4";
    const placeOrder: BuildPlaceOrder = opts.placeOrder === "layer-first" ? "layer-first" : "nearby-first";
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
    this.runtime.placeOrder = placeOrder;
    this.runtime.collectMissing = Boolean(opts.collectMissing);

    try {
      this.setPhase("preparing", "loading schematic…");
      const parsed = await loadParsedSchematic(opts.schematicId, version, transform);
      this.runtime.schematicName = parsed.meta.name;
      // üst yarı / portal vb. atla
      const blocks = this.sortBlocks(
        parsed.blocks.filter((b) => !shouldSkipBlock(b.name, b.properties))
      );
      this.runtime.total = blocks.length;
      this.refreshMaterials(blocks, true);

      // --- eksik malzeme toplama (sıralı, yakında yoksa çevre ara) ---
      if (opts.collectMissing) {
        this.setPhase("acquiring", "eksik malzemeler collecting…");
        this.setActivity("Picking up dropped items…", null);
        try {
          await this.instance.gather.runCollectDrops(undefined, 24, token, (p) => {
            report(p);
            this.setActivity(p.label ?? "Drops…", null);
            this.refreshMaterials(blocks, true);
          });
        } catch {
          /* */
        }
        this.refreshMaterials(blocks, true);
        const missingList = this.materialsFor(blocks).filter((m) => m.missing > 0);
        let ai = 0;
        for (const m of missingList) {
          if (token.cancelled) throw new Error(token.reason ?? "cancelled");
          ai++;
          this.setActivity(`Collecting: ${m.name} ×${m.missing} (${ai}/${missingList.length})`, m.name);
          report({
            done: ai - 1,
            total: missingList.length,
            label: `topla ${m.name} ×${m.missing}`
          });
          try {
            await this.acquireOneMaterial(m.name, m.missing, token, report, blocks);
          } catch (e) {
            this.log().warn(`Could not collect: ${m.name}`, e instanceof Error ? e.message : String(e));
            this.setActivity(
              `Failed: ${m.name} — ${e instanceof Error ? e.message : String(e)}`,
              m.name
            );
          }
          this.refreshMaterials(blocks, true);
        }
        this.setActivity(null, null);
        this.refreshMaterials(blocks, true);
      }

      const missing = this.runtime.materials.filter((m) => m.missing > 0);
      if (missing.length && !opts.allowPartial) {
        const msg = `Eksik malzeme: ${missing
          .slice(0, 5)
          .map((m) => `${m.name}×${m.missing}`)
          .join(", ")}${missing.length > 5 ? "…" : ""}`;
        this.setPhase("failed", msg, msg);
        this.log().warn("Build did not start — missing materials", msg);
        throw new Error(msg + " (partial build or gather materials)");
      }

      const origin = this.resolveOrigin(opts.origin);
      this.runtime.origin = origin;
      const rotLabel =
        transform.rotateY || transform.mirrorX || transform.mirrorZ
          ? ` · R${transform.rotateY ?? 0}${transform.mirrorX ? " mX" : ""}${transform.mirrorZ ? " mZ" : ""}`
          : "";
      this.setActivity(`Building: ${parsed.meta.name}`, null);
      this.setPhase("building", `build: ${parsed.meta.name}${rotLabel}`);
      this.log().info(
        `Build started: ${parsed.meta.name}`,
        `origin ${origin.x},${origin.y},${origin.z} · ${blocks.length} blok · order=${placeOrder}${rotLabel}`
      );

      // --- world koordinatları önceden hesap ---
      type Job = {
        block: SchematicBlock;
        name: string;
        wx: number;
        wy: number;
        wz: number;
        done: boolean;
        attempts: number;
        retryAt: number;
        status?: "placed" | "skipped" | "failed";
      };
      const jobs: Job[] = blocks.map((block) => ({
        block,
        name: block.name,
        wx: origin.x + block.dx,
        wy: origin.y + block.dy,
        wz: origin.z + block.dz,
        done: false,
        attempts: 0,
        retryAt: 0
      }));
      this.log().info(
        "Build targets ready",
        `${jobs.length} koordinat · support priority · sticky target · stop-and-place`
      );
      let placed = 0;
      let skipped = 0;
      let failed = 0;
      let consecutiveFail = 0;
      let acquirePasses = 0;
      let acquireStalls = 0;
      /** sticky: aynı bloğa bitirene kadar yapış — zig-zag dengesizliği azaltır */
      let stickyJob: Job | null = null;
      /** başarılı/atlmainn hücreler — destek skoru for */
      const solidKeys = new Set<string>();
      const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

      const remainingBlocks = () => jobs.filter((job) => !job.done).map((job) => job.block);
      const refreshRemaining = () => {
        this.runtime.materials = this.materialsFor(remainingBlocks());
        this.emit(true);
      };
      refreshRemaining();

      const worldSolid = (x: number, y: number, z: number): boolean => {
        if (solidKeys.has(keyOf(x, y, z))) return true;
        const bot = this.instance.bot;
        if (!bot) return false;
        const b = bot.blockAt(v3(x, y, z));
        if (!b) return false;
        const n = b.name.replace(/^minecraft:/, "");
        return (
          n !== "air" &&
          n !== "cave_air" &&
          n !== "void_air" &&
          n !== "water" &&
          n !== "lava" &&
          n !== "flowing_water" &&
          n !== "flowing_lava" &&
          n !== "bubble_column" &&
          n !== "short_grass" &&
          n !== "tall_grass" &&
          n !== "grass" &&
          n !== "snow"
        );
      };

      const hasSupport = (job: Job): boolean => worldSolid(job.wx, job.wy - 1, job.wz);

      /** Düşük skor = önce. Destek + alt katman + distance dengesi (sadece en yakın ≠ stabil). */
      const scoreJob = (job: Job): number => {
        const d = distToBlock(this.instance, job.wx, job.wy, job.wz);
        const supportPen = hasSupport(job) ? 0 : 420;
        const botY = Math.floor(this.instance.bot?.entity?.position.y ?? job.wy);
        const climbPen = Math.max(0, job.wy - botY - 1) * 35;
        if (placeOrder === "layer-first") {
          // katman (Y) mutlak öncelik, sonra destek, sonra distance
          return job.wy * 80_000 + supportPen + d * 25 + climbPen;
        }
        // nearby-first: distance baskın ama alt katman + destek hâlâ tercih
        return d * 95 + job.wy * 12 + supportPen + climbPen;
      };

      const markDone = (job: Job, res: "placed" | "skipped" | "failed") => {
        if (job.done) return;
        job.done = true;
        job.status = res;
        if (res === "placed") {
          placed++;
          solidKeys.add(keyOf(job.wx, job.wy, job.wz));
          this.scaffolds.protectStructure(job.wx, job.wy, job.wz);
          consecutiveFail = 0;
        } else if (res === "skipped") {
          skipped++;
          solidKeys.add(keyOf(job.wx, job.wy, job.wz));
          consecutiveFail = 0;
        } else {
          failed++;
          consecutiveFail++;
        }
        if (stickyJob === job) stickyJob = null;
        this.pushBlockEvent({ name: job.name, x: job.wx, y: job.wy, z: job.wz, status: res, t: Date.now() });
        this.runtime.placed = placed;
        this.runtime.skipped = skipped;
        this.runtime.failed = failed;
        this.runtime.scaffoldsPlaced = this.scaffolds.count;
        const doneN = placed + skipped + failed;
        const act =
          res === "placed" ? `Placed: ${job.name}` : res === "skipped" ? `Skipped: ${job.name}` : `Permanent error: ${job.name}`;
        this.runtime.activity = `${act} · ${doneN}/${jobs.length}`;
        this.runtime.activityMaterial = job.name;
        this.runtime.label = `${job.name} @${job.wx},${job.wy},${job.wz} · ${doneN}/${jobs.length} · +${placed}`;
        refreshRemaining();
      };

      const processPlacement = (job: Job, res: "placed" | "skipped" | "failed" | "outofreach") => {
        if (res === "placed" || res === "skipped") {
          markDone(job, res);
          return;
        }
        if (res === "outofreach") return;
        job.attempts++;
        consecutiveFail++;
        if (job.attempts >= 4) {
          markDone(job, "failed");
          return;
        }
        // biraz daha sabır — anında yeniden seçim dengesizlik yapıyordu
        job.retryAt = Date.now() + 280 + job.attempts * 220;
        this.runtime.activity = `Yeniden denenecek: ${job.name} (${job.attempts}/4)`;
        this.runtime.activityMaterial = job.name;
        this.runtime.label = `temporary place error · ${job.name}`;
        this.emit(true);
      };

      const pickNextJob = (ready: Job[]): Job => {
        // sticky: hâlâ uygunsa aynı targete yapış (sağa sola zıplama yok)
        if (
          stickyJob &&
          !stickyJob.done &&
          stickyJob.retryAt <= Date.now() &&
          this.hasItemForBlock(stickyJob.name) &&
          ready.includes(stickyJob)
        ) {
          return stickyJob;
        }
        let best = ready[0]!;
        let bestS = scoreJob(best);
        for (const job of ready) {
          const s = scoreJob(job);
          if (s < bestS) {
            bestS = s;
            best = job;
          }
        }
        stickyJob = best;
        return best;
      };

      /**
       * Menzildeki blokları path AÇMADAN koy (yürürken / cluster).
       * stopFirst=true: durup koy; false: path bozma (yürürken).
       */
      const placeReachable = async (optsPlace?: {
        stopFirst?: boolean;
        maxCluster?: number;
      }): Promise<number> => {
        let processed = 0;
        const now = Date.now();
        const stopFirst = optsPlace?.stopFirst !== false;
        const maxCluster = optsPlace?.maxCluster ?? 14;
        const open = jobs.filter(
          (job) => !job.done && job.retryAt <= now && this.hasItemForBlock(job.name)
        );
        open.sort((a, b) => scoreJob(a) - scoreJob(b));
        if (stopFirst) {
          try {
            this.instance.bot?.pathfinder?.setGoal(null);
            this.instance.bot?.clearControlStates();
          } catch {
            /* */
          }
          if (open.length) await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        for (const job of open) {
          if (processed >= maxCluster) break;
          if (token.cancelled) throw new Error(token.reason ?? "cancelled");
          if (distToBlock(this.instance, job.wx, job.wy, job.wz) > PLACE_REACH) continue;
          const res = await placeBlockAt(
            this.instance,
            job.wx,
            job.wy,
            job.wz,
            job.name,
            token,
            this.scaffolds,
            { retries: 1, skipPath: true, softSettle: !stopFirst }
          );
          processPlacement(job, res);
          if (res === "placed" || res === "skipped") processed++;
        }
        return processed;
      };

      const jobSoftRetry = (job: Job) => {
        // failed sayma — yeniden yürüme hakkı; 8 denemeden sonra vazgeç
        if (job.attempts >= 8) {
          markDone(job, "failed");
          return;
        }
        job.attempts++;
        job.retryAt = Date.now() + 100;
        consecutiveFail++;
      };

      // --- yürü + menzilde koy + targete git (ulaşmadan zorlama) ---
      let guard = 0;
      const maxRounds = jobs.length * 16 + 120;
      let lastWalkTick = 0;
      while (jobs.some((job) => !job.done) && guard < maxRounds) {
        if (token.cancelled) throw new Error(token.reason ?? "cancelled");
        guard++;
        // önce menzildekiler (zaten yanındaysa yürüme)
        await placeReachable({ stopFirst: true, maxCluster: 12 });
        if (!jobs.some((job) => !job.done)) break;

        const pending = jobs.filter((job) => !job.done);
        const now = Date.now();
        const ready = pending.filter((job) => job.retryAt <= now && this.hasItemForBlock(job.name));

        if (!ready.length) {
          const delayed = pending.filter((job) => this.hasItemForBlock(job.name));
          if (delayed.length) {
            const waitMs = Math.max(80, Math.min(500, Math.min(...delayed.map((job) => job.retryAt - now))));
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            continue;
          }

          if (!opts.allowPartial || acquirePasses >= 6 || acquireStalls >= 2) break;
          stickyJob = null;
          acquirePasses++;
          const beforeMissing = this.materialsFor(remainingBlocks()).reduce(
            (sum, material) => sum + material.missing,
            0
          );
          this.setPhase("acquiring", `build waiting — missing material pass ${acquirePasses}`);
          this.setActivity("Collecting dropped build materials…", null);
          try {
            await this.instance.gather.runCollectDrops(undefined, 24, token, (p) => {
              this.setActivity(p.label ?? "Ground itemslar…", null);
              refreshRemaining();
            });
          } catch {
            /* */
          }

          const missingNow = this.materialsFor(remainingBlocks())
            .filter((material) => material.missing > 0)
            .slice(0, 4);
          for (const material of missingNow) {
            if (token.cancelled) throw new Error(token.reason ?? "cancelled");
            try {
              await this.acquireOneMaterial(
                material.name,
                material.missing,
                token,
                report,
                remainingBlocks()
              );
            } catch (error) {
              this.log().warn(
                `Could not acquire material during build: ${material.name}`,
                error instanceof Error ? error.message : String(error)
              );
            }
            refreshRemaining();
          }

          const afterMissing = this.materialsFor(remainingBlocks()).reduce(
            (sum, material) => sum + material.missing,
            0
          );
          acquireStalls = afterMissing < beforeMissing ? 0 : acquireStalls + 1;
          this.setActivity(`Building: ${parsed.meta.name}`, null);
          this.setPhase("building", `build continuing: ${parsed.meta.name}`);
          continue;
        }

        const next = pickNextJob(ready);
        const dist = distToBlock(this.instance, next.wx, next.wy, next.wz);
        this.runtime.label = `walk → ${next.wx},${next.wy},${next.wz} · remaining ${pending.length}`;
        this.runtime.activity =
          dist > PLACE_REACH
            ? `Walking: ${next.name} (${dist.toFixed(1)}m) @${next.wx},${next.wy},${next.wz}`
            : `Koyuyor: ${next.name} @${next.wx},${next.wy},${next.wz}`;
        this.runtime.activityMaterial = next.name;
        report({ done: placed + skipped + failed, total: jobs.length, label: this.runtime.label });
        this.emit(true);

        // UZAKSA: target bloğa yürü; yolda menzile girenleri koy (hareket ederek inşa)
        if (dist > PLACE_REACH) {
          await pathNear(
            this.instance,
            next.wx + 0.5,
            next.wy,
            next.wz + 0.5,
            2.6,
            token,
            {
              clearGoal: true,
              timeoutMs: 14_000,
              onTick: async () => {
                const t = Date.now();
                if (t - lastWalkTick < 280) return;
                lastWalkTick = t;
                await placeReachable({ stopFirst: false, maxCluster: 3 });
              }
            }
          );
        }

        if (!next.done && this.hasItemForBlock(next.name)) {
          // skipPath:false → menzil dışındaysa placeBlockAt KENDİSİ path açar (zorlamaz)
          const res = await placeBlockAt(
            this.instance,
            next.wx,
            next.wy,
            next.wz,
            next.name,
            token,
            this.scaffolds,
            { retries: 3, skipPath: false }
          );
          // outofreach: failed sayma — tekrar yürüyecek
          if (res === "outofreach") {
            this.runtime.activity = `Unreachable, walking again: ${next.name}`;
            this.emit(true);
            // sticky tut ama kısa bekle, tekrar path
            jobSoftRetry(next);
          } else {
            processPlacement(next, res);
          }
        }

        // yanındakileri bitir
        await placeReachable({ stopFirst: true, maxCluster: 16 });

        if (consecutiveFail >= 5) {
          this.runtime.label = `placent recovering (${consecutiveFail})`;
          stickyJob = null;
          this.emit(true);
          try {
            this.instance.bot?.pathfinder?.setGoal(null);
            this.instance.bot?.clearControlStates();
          } catch {
            /* */
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 350));
          consecutiveFail = 0;
        }
        if (guard % 2 === 0) refreshRemaining();
      }

      // remainingları (maxRounds) failed say
      for (const j of jobs) {
        if (!j.done) markDone(j, "failed");
      }

      try {
        this.instance.bot?.pathfinder?.setGoal(null);
      } catch {
        /* */
      }

      this.flushEmit();
      this.setPhase("cleanup", "cleaning temporary blocks…");
      this.log().info("Scaffold cleanup", `${this.scaffolds.count} entries`);
      const cleared = await this.scaffolds.cleanup(this.instance.bot!, token, (c, t) => {
        this.runtime.scaffoldsCleared = c;
        this.runtime.label = `temizlik ${c}/${t}`;
        report({ done: jobs.length, total: jobs.length, label: `scaffold ${c}/${t}` });
        this.emit();
      });
      this.runtime.scaffoldsCleared = cleared;

      if (token.cancelled) {
        this.setPhase("cancelled", "cancelled edildi");
        throw new Error(token.reason ?? "cancelled");
      }

      const label = `done: ${placed} placed, ${skipped} skipped, ${failed} failed, scaffold ${cleared}`;
      this.runtime.materials = this.materialsFor(jobs.filter((job) => job.status === "failed").map((job) => job.block));
      this.emit(true);
      this.setActivity(null, null);
      // Tam başarıda done + dur; hata varsa failed (görev de fail)
      if (failed === 0) {
        this.setPhase("done", label);
        this.log().success(`Build complete: ${parsed.meta.name}`, label);
        report({ done: jobs.length, total: jobs.length, label });
      } else {
        this.setPhase("failed", label, `${failed} blok placeilemedi`);
        this.log().warn(`Build partial/failed: ${parsed.meta.name}`, label);
        report({ done: jobs.length, total: jobs.length, label });
        throw new Error(label);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        if (this.scaffolds.count && this.instance.bot) {
          this.setPhase("cleanup", "cancelled — scaffold cleanup…");
          await this.scaffolds.cleanup(this.instance.bot, { cancelled: false });
        }
      } catch {
        /* */
      }
      if (this.runtime.phase !== "failed" && this.runtime.phase !== "cancelled") {
        this.setPhase(token.cancelled ? "cancelled" : "failed", msg, msg);
      }
      this.log().error("Build error/cancelled", msg);
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

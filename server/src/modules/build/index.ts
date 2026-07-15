import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import { shouldSkipBlock } from "./blocks";
import { loadParsedSchematic, materialCounts } from "./library";
import { distToBlock, itemNameForBlock, pathNear, placeBlockAt, PLACE_REACH } from "./place";
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
    const aliasHave = (blockName: string): number => {
      const names = itemNameForBlock(blockName);
      let best = 0;
      for (const n of names) best = Math.max(best, haveMap[n] ?? 0);
      if (haveMap[blockName] != null) best = Math.max(best, haveMap[blockName]!);
      return best;
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
   * 1) yere düşenler  2) her eksik tür için collect/mine (yakın → halka arama)
   */
  enqueueCollectMissing(opts: { schematicId: string; versionHint?: string; transform?: BuildTransform }) {
    const sid = opts.schematicId.trim();
    if (!sid) throw new Error("Şema id gerekli");
    const version = opts.versionHint || "1.20.4";

    return this.instance.tasks.enqueue(
      {
        type: "build-acquire",
        label: `eksik malzeme: ${sid.slice(0, 8)}…`,
        priority: PRIORITY.USER,
        params: { schematicId: sid },
        requeueOnPreempt: false
      },
      () => async (token, report) => {
        this.setPhase("acquiring", "malzeme listesi…");
        report({ done: 0, total: 1, label: "malzeme listesi…" });
        const parsed = await loadParsedSchematic(sid, version, opts.transform);
        const blocks = parsed.blocks.filter((b) => !shouldSkipBlock(b.name, b.properties));
        let mats = this.materialsFor(blocks);
        this.runtime.materials = mats;
        this.emit(true);

        // önce yakındaki yer eşyaları
        try {
          report({ done: 0, total: 1, label: "yere düşenler…" });
          await this.instance.gather.runCollectDrops(undefined, 28, token, report);
        } catch {
          /* best-effort */
        }

        mats = this.materialsFor(blocks);
        const missing = mats.filter((m) => m.missing > 0);
        if (!missing.length) {
          this.setPhase("idle", "eksik malzeme yok");
          report({ done: 1, total: 1, label: "eksik yok" });
          return;
        }

        // sırayla her eksik — yakında yoksa runCollectBlock halka arar
        let i = 0;
        for (const m of missing) {
          if (token.cancelled) throw new Error(token.reason ?? "iptal");
          i++;
          this.setPhase("acquiring", `topla ${m.name} ×${m.missing} (${i}/${missing.length})`);
          report({ done: i - 1, total: missing.length, label: `topla ${m.name} ×${m.missing}` });
          try {
            await this.acquireOneMaterial(m.name, m.missing, token, report);
          } catch (e) {
            this.log().warn(`Malzeme toplanamadı: ${m.name}`, e instanceof Error ? e.message : String(e));
          }
          this.runtime.materials = this.materialsFor(blocks);
          this.emit(true);
        }

        const still = this.materialsFor(blocks).filter((m) => m.missing > 0);
        const label =
          still.length === 0
            ? "malzemeler tamam"
            : `kısmi: hâlâ eksik ${still
                .slice(0, 4)
                .map((m) => `${m.name}×${m.missing}`)
                .join(", ")}`;
        this.setPhase(still.length === 0 ? "idle" : "failed", label, still.length ? label : undefined);
        report({ done: missing.length, total: missing.length, label });
        this.log().info("Eksik malzeme toplama bitti", label);
      }
    );
  }

  /** Tek malzeme topla (inline — build veya acquire görevi) */
  private async acquireOneMaterial(
    blockName: string,
    count: number,
    token: TaskToken,
    report: ProgressFn
  ) {
    const item = itemNameForBlock(blockName)[0] ?? blockName;
    const n = Math.max(1, count);
    await this.instance.gather.runCollectBlock(item, n, token, report);
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
    const buildTypes = new Set(["build", "build-acquire", "build-acquire-plan"]);
    const cur = this.instance.tasks.currentSummary;
    if (cur && buildTypes.has(cur.type)) this.instance.tasks.cancel(cur.id, reason);
    for (const t of this.instance.tasks.queueSummaries) {
      if (buildTypes.has(t.type)) this.instance.tasks.cancel(t.id, reason);
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
    /** eksik malzemeleri önce kuyruğa al (kaynak görevleri + inşaat) */
    collectMissing?: boolean;
    /** nearby-first: envanterde olan/yakın önce; layer-first: serpentine */
    placeOrder?: BuildPlaceOrder;
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

  /** Katman katman, her katmanda yılan yolu (yürürken yerleştirme için) */
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

      // --- eksik malzeme toplama (sıralı, yakında yoksa çevre ara) ---
      if (opts.collectMissing) {
        this.setPhase("acquiring", "eksik malzemeler toplanıyor…");
        try {
          await this.instance.gather.runCollectDrops(undefined, 24, token, report);
        } catch {
          /* */
        }
        let missingList = this.materialsFor(blocks).filter((m) => m.missing > 0);
        let ai = 0;
        for (const m of missingList) {
          if (token.cancelled) throw new Error(token.reason ?? "iptal");
          ai++;
          this.setPhase("acquiring", `topla ${m.name} ×${m.missing} (${ai}/${missingList.length})`);
          report({
            done: ai - 1,
            total: missingList.length,
            label: `topla ${m.name} ×${m.missing}`
          });
          try {
            await this.acquireOneMaterial(m.name, m.missing, token, report);
          } catch (e) {
            this.log().warn(`Toplanamadı: ${m.name}`, e instanceof Error ? e.message : String(e));
          }
          this.runtime.materials = this.materialsFor(blocks);
          this.emit(true);
        }
        this.runtime.materials = this.materialsFor(blocks);
      }

      const missing = this.runtime.materials.filter((m) => m.missing > 0);
      if (missing.length && !opts.allowPartial) {
        const msg = `Eksik malzeme: ${missing
          .slice(0, 5)
          .map((m) => `${m.name}×${m.missing}`)
          .join(", ")}${missing.length > 5 ? "…" : ""}`;
        this.setPhase("failed", msg, msg);
        this.log().warn("İnşaat başlamadı — eksik malzeme", msg);
        throw new Error(msg + " (kısmi inşaat veya malzeme topla)");
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
        `origin ${origin.x},${origin.y},${origin.z} · ${blocks.length} blok · sıra=${placeOrder}${rotLabel}`
      );

      // --- dünya koordinatları önceden hesap ---
      type Job = {
        name: string;
        wx: number;
        wy: number;
        wz: number;
        done: boolean;
        status?: "placed" | "skipped" | "failed";
      };
      const jobs: Job[] = blocks.map((b) => ({
        name: b.name,
        wx: origin.x + b.dx,
        wy: origin.y + b.dy,
        wz: origin.z + b.dz,
        done: false
      }));
      this.log().info("İnşaat hedefleri hazır", `${jobs.length} koordinat · yürürken yerleştirme`);

      let placed = 0;
      let skipped = 0;
      let failed = 0;
      let consecutiveFail = 0;
      this.runtime.materials = this.materialsFor(blocks);

      const markDone = (job: Job, res: "placed" | "skipped" | "failed") => {
        if (job.done) return;
        job.done = true;
        job.status = res;
        if (res === "placed") {
          placed++;
          this.scaffolds.protectStructure(job.wx, job.wy, job.wz);
          consecutiveFail = 0;
        } else if (res === "skipped") {
          skipped++;
          consecutiveFail = 0;
        } else {
          failed++;
          consecutiveFail++;
        }
        this.pushBlockEvent({
          name: job.name,
          x: job.wx,
          y: job.wy,
          z: job.wz,
          status: res,
          t: Date.now()
        });
        this.runtime.placed = placed;
        this.runtime.skipped = skipped;
        this.runtime.failed = failed;
        this.runtime.scaffoldsPlaced = this.scaffolds.count;
        const doneN = placed + skipped + failed;
        this.runtime.label = `${job.name} @${job.wx},${job.wy},${job.wz} · ${doneN}/${jobs.length} · +${placed}`;
        this.emit();
      };

      /** nearby-first: envanterde olan önce, sonra mesafe; layer-first: mesafe */
      const pickNextJob = (pending: Job[]): Job => {
        if (placeOrder === "layer-first") {
          let next = pending[0]!;
          let bestD = distToBlock(this.instance, next.wx, next.wy, next.wz);
          for (const j of pending) {
            const d = distToBlock(this.instance, j.wx, j.wy, j.wz);
            if (d < bestD) {
              bestD = d;
              next = j;
            }
          }
          return next;
        }
        // nearby-first: önce malzeme var olanlar, onlar arasında en yakın
        const withItem = pending.filter((j) => this.hasItemForBlock(j.name));
        const pool = withItem.length ? withItem : pending;
        let next = pool[0]!;
        let bestD = distToBlock(this.instance, next.wx, next.wy, next.wz);
        for (const j of pool) {
          const d = distToBlock(this.instance, j.wx, j.wy, j.wz);
          if (d < bestD) {
            bestD = d;
            next = j;
          }
        }
        return next;
      };

      /** Menzildeki tüm açık işleri bakıp koy (path açmadan) */
      const placeReachable = async (): Promise<number> => {
        let n = 0;
        const open = jobs.filter((j) => !j.done);
        open.sort((a, b) => {
          if (placeOrder === "nearby-first") {
            const ha = this.hasItemForBlock(a.name) ? 0 : 1;
            const hb = this.hasItemForBlock(b.name) ? 0 : 1;
            if (ha !== hb) return ha - hb;
          }
          return (
            distToBlock(this.instance, a.wx, a.wy, a.wz) - distToBlock(this.instance, b.wx, b.wy, b.wz)
          );
        });
        for (const job of open) {
          if (token.cancelled) throw new Error(token.reason ?? "iptal");
          if (distToBlock(this.instance, job.wx, job.wy, job.wz) > PLACE_REACH) continue;
          // envanterde yoksa atla (failed spam yok) — sonda ele alınır
          if (placeOrder === "nearby-first" && !this.hasItemForBlock(job.name)) continue;
          const res = await placeBlockAt(
            this.instance,
            job.wx,
            job.wy,
            job.wz,
            job.name,
            token,
            this.scaffolds,
            { retries: 1, skipPath: true }
          );
          if (res === "outofreach") continue;
          markDone(job, res);
          n++;
        }
        return n;
      };

      // --- yürürken yerleştirme ana döngü ---
      let guard = 0;
      const maxRounds = jobs.length * 6 + 20;
      while (jobs.some((j) => !j.done) && guard < maxRounds) {
        if (token.cancelled) throw new Error(token.reason ?? "iptal");
        guard++;

        // 1) menzildekileri koy
        await placeReachable();
        if (!jobs.some((j) => !j.done)) break;

        // 2) sıradaki hedefe yürü
        const pending = jobs.filter((j) => !j.done);
        // nearby-first: sadece malzemesi olanlara yürü; hepsi eksikse en yakın
        const walkPool =
          placeOrder === "nearby-first"
            ? pending.filter((j) => this.hasItemForBlock(j.name))
            : pending;
        const next = pickNextJob(walkPool.length ? walkPool : pending);

        this.runtime.label = `yürü → ${next.wx},${next.wy},${next.wz} · kalan ${pending.length}`;
        report({
          done: placed + skipped + failed,
          total: jobs.length,
          label: this.runtime.label
        });
        this.emit();

        // pathfinder hedefi bırakmadan yürü; yolda menzile girenleri koy
        await pathNear(
          this.instance,
          next.wx + 0.5,
          next.wy,
          next.wz + 0.5,
          2.6,
          token,
          {
            clearGoal: false,
            timeoutMs: 6000,
            onTick: async () => {
              await placeReachable();
            }
          }
        );

        // 3) hedefe yaklaşıldı — path kes, bakıp koy (gerekirse scaffold)
        try {
          this.instance.bot?.pathfinder?.setGoal(null);
        } catch {
          /* */
        }

        if (!next.done) {
          const res = await placeBlockAt(
            this.instance,
            next.wx,
            next.wy,
            next.wz,
            next.name,
            token,
            this.scaffolds,
            { retries: 2, skipPath: false }
          );
          if (res === "outofreach") {
            // hâlâ uzak — fail sayma, sonraki tur
          } else {
            markDone(next, res);
          }
        }

        // 4) tur sonunda menzilde kalanları bir daha
        await placeReachable();

        if (consecutiveFail >= 6) {
          this.runtime.label = `yol sorunu — mola (${consecutiveFail} hata)`;
          this.emit(true);
          try {
            this.instance.bot?.pathfinder?.setGoal(null);
          } catch {
            /* */
          }
          await new Promise((r) => setTimeout(r, 350));
          consecutiveFail = 0;
        }

        if (guard % 5 === 0) {
          this.runtime.materials = this.materialsFor(
            jobs.filter((j) => !j.done).map((j) => ({ dx: 0, dy: 0, dz: 0, name: j.name }))
          );
        }
      }

      // kalanları (maxRounds) failed say
      for (const j of jobs) {
        if (!j.done) markDone(j, "failed");
      }

      try {
        this.instance.bot?.pathfinder?.setGoal(null);
      } catch {
        /* */
      }

      this.flushEmit();
      this.setPhase("cleanup", "geçici bloklar temizleniyor…");
      this.log().info("Scaffold temizliği", `${this.scaffolds.count} kayıt`);
      const cleared = await this.scaffolds.cleanup(this.instance.bot!, token, (c, t) => {
        this.runtime.scaffoldsCleared = c;
        this.runtime.label = `temizlik ${c}/${t}`;
        report({ done: jobs.length, total: jobs.length, label: `scaffold ${c}/${t}` });
        this.emit();
      });
      this.runtime.scaffoldsCleared = cleared;

      if (token.cancelled) {
        this.setPhase("cancelled", "iptal edildi");
        throw new Error(token.reason ?? "iptal");
      }

      const label = `bitti: ${placed} kondu, ${skipped} atlandı, ${failed} başarısız, scaffold ${cleared}`;
      this.runtime.materials = this.materialsFor([]);
      // Tam başarıda done + dur; hata varsa failed (görev de fail)
      if (failed === 0) {
        this.setPhase("done", label);
        this.log().success(`İnşaat tamam: ${parsed.meta.name}`, label);
        report({ done: jobs.length, total: jobs.length, label });
      } else {
        this.setPhase("failed", label, `${failed} blok yerleştirilemedi`);
        this.log().warn(`İnşaat kısmi/hatalı: ${parsed.meta.name}`, label);
        report({ done: jobs.length, total: jobs.length, label });
        throw new Error(label);
      }
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

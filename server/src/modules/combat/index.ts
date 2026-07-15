import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import type { CombatConfig, CombatRuntime, CompanionState, DeathRecord } from "../../types";
import { goals } from "mineflayer-pathfinder";
import { ensureMovement, runFollow, runGoto, stopMovement } from "../movement";
import { stepLookAtEntity } from "../movement/look";
import { CREEPER_SAFE_RANGE, isHostileMob, isPlayerEntity } from "./mobs";
import {
  distanceEyeToEntity,
  inMeleeRange,
  randomReactionMs,
  tryRealisticAttack
} from "./realism";
import { isBadCombatHeld, isMeleeWeapon, pickBestWeaponName } from "./weapons";

const DEATH_LOOT_MS = 5 * 60 * 1000;
const HOSTILE_SCAN_MS = 400;
const PROTECT_TICK_MS = 600;
/** boşta öz savunma tarama aralığı */
const SELF_GUARD_TICK_MS = 700;

// caya-combat-mlg-stability-v2: erişilemeyen/ışınlanan hedef bekçisi.
const caya_combat_mlg_stability_v2_combat = true;
const UNREACHABLE_TARGET_TTL_MS = 15_000;
const TARGET_TELEPORT_DELTA = 10;
const APPROACH_STALL_RETRY_MS = 3_500;
const APPROACH_STALL_ABORT_MS = 7_500;

const defaultCompanion = (): CompanionState => ({
  followPlayer: null,
  followDistance: 3,
  attackPlayer: null,
  protectPlayers: [],
  protectPlayer: null,
  protectSettings: {
    range: 10,
    protectAggro: "threats",
    retaliateMobs: true,
    retaliatePlayers: true,
    whitelist: []
  }
});

/**
 * Per-bot combat brain (Faz 6). All hits go through RealismLayer.
 * Defense hooks attach on spawn; tasks run via TaskQueue (DEFENSE/SURVIVAL/USER).
 * Companion: takip / saldırı / koruma toggle (yakındaki oyuncular paneli).
 */
export class CombatService {
  private bot: Bot | null = null;
  private lastSwing = { t: 0 };
  private lastHealth = 20;
  private activeTargetLabel: string | null = null;
  private mode: CombatRuntime["mode"] = "idle";
  private lastDeath: DeathRecord | null = null;
  private healthHook: (() => void) | null = null;
  private deathHook: (() => void) | null = null;
  private entityGoneHook: ((e: Entity) => void) | null = null;
  private companion: CompanionState = defaultCompanion();
  private protectTimer: NodeJS.Timeout | null = null;
  private selfGuardTimer: NodeJS.Timeout | null = null;
  private followTaskId: string | null = null;
  private attackTaskId: string | null = null;
  /** ölüm → respawn arası hareket/koruma dondur (pathfinder kilitlenmesi) */
  private deadPaused = false;
  /** threats modu: yakın zamanda botu vuran oyuncular (label → expireMs) */
  private recentThreats = new Map<string, number>();
  /** entity id → tekrar denenebileceği zaman */
  private unreachableTargets = new Map<number, number>();

  constructor(private readonly instance: BotInstance) {}

  private markThreat(label: string, ttlMs = 20_000) {
    if (!label) return;
    this.recentThreats.set(label, Date.now() + ttlMs);
  }

  private isRecentThreat(label: string): boolean {
    const exp = this.recentThreats.get(label);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.recentThreats.delete(label);
      return false;
    }
    return true;
  }

  private pruneThreats() {
    const now = Date.now();
    for (const [k, exp] of this.recentThreats) {
      if (now > exp) this.recentThreats.delete(k);
    }
    this.pruneUnreachableTargets(now);
  }

  private pruneUnreachableTargets(now = Date.now()) {
    for (const [id, until] of this.unreachableTargets) {
      if (now >= until) this.unreachableTargets.delete(id);
    }
  }

  private isTargetTemporarilyUnreachable(entity: Entity | null | undefined): boolean {
    if (!entity || typeof entity.id !== "number") return false;
    const until = this.unreachableTargets.get(entity.id);
    if (!until) return false;
    if (Date.now() >= until) {
      this.unreachableTargets.delete(entity.id);
      return false;
    }
    return true;
  }

  private clearTargetUnreachable(entity: Entity | null | undefined) {
    if (entity && typeof entity.id === "number") this.unreachableTargets.delete(entity.id);
  }

  private markTargetUnreachable(entity: Entity, reason: string, ttlMs = UNREACHABLE_TARGET_TTL_MS) {
    if (typeof entity.id !== "number") return;
    const now = Date.now();
    const previous = this.unreachableTargets.get(entity.id) ?? 0;
    const until = now + Math.max(2_000, ttlMs);
    this.unreachableTargets.set(entity.id, Math.max(previous, until));
    if (previous <= now) {
      this.log().warn(
        "Hedefe ulaşılamıyor — geçici olarak atlandı",
        labelEntity(entity) + " · " + reason + " · " + Math.ceil(ttlMs / 1000) + " sn"
      );
    }
  }

getRuntime(): CombatRuntime {
    const protectPlayers = [...this.companion.protectPlayers];
    const protectPlayer = this.primaryProtectLabel();
    return {
      defendMode: this.instance.config.combat.defendMode,
      fighting: this.mode !== "idle",
      mode: this.mode,
      activeTarget: this.activeTargetLabel,
      lastDeath: this.lastDeath,
      companion: {
        ...this.companion,
        protectPlayers,
        protectPlayer,
        protectSettings: {
          ...this.companion.protectSettings,
          whitelist: [...this.companion.protectSettings.whitelist]
        }
      }
    };
  }

  /** Ana korunan etiketi: takip edilen listedeyse o, yoksa ilk korunan */
  private primaryProtectLabel(): string | null {
    const list = this.companion.protectPlayers;
    if (!list.length) return null;
    const follow = this.companion.followPlayer;
    if (follow && list.some((p) => p.toLowerCase() === follow.toLowerCase())) return follow;
    return list[0] ?? null;
  }

  private isProtectedName(name: string): boolean {
    const n = name.toLowerCase();
    return this.companion.protectPlayers.some((p) => p.toLowerCase() === n);
  }

  private hasProtect(): boolean {
    return this.companion.protectPlayers.length > 0;
  }

  private emitCombat() {
    this.instance.emit("combat", { botId: this.instance.config.id, combat: this.getRuntime() });
  }

  private setMode(mode: CombatRuntime["mode"], target: string | null = this.activeTargetLabel) {
    this.mode = mode;
    this.activeTargetLabel = target;
    this.emitCombat();
  }

  private cfg(): CombatConfig {
    return this.instance.config.combat;
  }

  private log() {
    return this.instance.getLogger();
  }

  attach(bot: Bot) {
    this.detachKeepCompanion();
    this.bot = bot;
    this.lastHealth = bot.health ?? 20;
    this.lastSwing.t = 0;

    this.healthHook = () => this.onHealthChange();
    bot.on("health", this.healthHook);

    this.deathHook = () => this.onDeath();
    bot.on("death", this.deathHook);

    this.entityGoneHook = (e: Entity) => {
      if (this.activeTargetLabel && labelEntity(e) === this.activeTargetLabel) {
        // target despawned — fighter loops will notice
      }
    };
    bot.on("entityGone", this.entityGoneHook);

    this.deadPaused = false;
    // boşta öz savunma (defendMode) — zombie yaklaşınca savunsun / kaçsın
    this.startSelfGuardLoop();
    // reconnect / ilk spawn: companion görevlerini yeniden başlat
    this.resumeCompanionAfterAlive("attach");

    this.emitCombat();
  }

  /**
   * Ölüm sonrası respawn/spawn: pathfinder kilitlenmesin diye görevler ölümde durur;
   * buradan koruma/takip yeniden kurulur.
   */
  onRespawnOrSpawn() {
    if (!this.bot) {
      this.bot = this.instance.bot;
    }
    this.deadPaused = false;
    this.lastHealth = this.bot?.health ?? 20;
    this.resumeCompanionAfterAlive("respawn");
    this.emitCombat();
  }

  private resumeCompanionAfterAlive(reason: string) {
    if (this.deadPaused) return;
    if (this.instance.status !== "online") return;
    // kısa gecikme: entity/pathfinder hazır olsun
    setTimeout(() => {
      if (this.deadPaused || this.instance.status !== "online") return;
      try {
        if (this.hasProtect()) {
          this.startProtectLoop();
          const main = this.companion.followPlayer ?? this.companion.protectPlayers[0];
          if (main) this.ensureFollowTask(main, this.companion.followDistance, true);
          this.setMode("protecting", this.primaryProtectLabel());
          this.log().info("Koruma/takip yeniden başlatıldı", reason);
        } else if (this.companion.followPlayer) {
          this.ensureFollowTask(this.companion.followPlayer, this.companion.followDistance, true);
          this.log().info("Takip yeniden başlatıldı", reason);
        }
        if (this.companion.attackPlayer) this.ensureAttackTask(this.companion.attackPlayer);
      } catch (e) {
        this.log().debug("Companion resume", e instanceof Error ? e.message : String(e));
      }
      this.emitCombat();
    }, 600);
  }

  /** detach bot listeners but keep companion settings for reconnect */
  private detachKeepCompanion() {
    this.stopProtectLoop();
    this.stopSelfGuardLoop();
    const bot = this.bot;
    if (bot) {
      if (this.healthHook) bot.removeListener("health", this.healthHook);
      if (this.deathHook) bot.removeListener("death", this.deathHook);
      if (this.entityGoneHook) bot.removeListener("entityGone", this.entityGoneHook);
    }
    this.healthHook = null;
    this.deathHook = null;
    this.entityGoneHook = null;
    this.bot = null;
  }

  detach() {
    this.detachKeepCompanion();
    this.companion = defaultCompanion();
    this.followTaskId = null;
    this.attackTaskId = null;
    this.setMode("idle", null);
  }

  stopCombat(reason = "dövüş durduruldu") {
    this.companion.attackPlayer = null;
    this.attackTaskId = null;
    this.cancelTasksOfType("attack");
    this.cancelTasksOfType("defend");
    if (this.hasProtect()) {
      this.setMode("protecting", this.primaryProtectLabel());
    } else if (this.companion.followPlayer) {
      this.setMode("idle", this.companion.followPlayer);
    } else {
      this.setMode("idle", null);
    }
    this.log().info("Dövüş bırakıldı", reason);
    this.emitCombat();
  }

  /** Tüm companion (takip/saldırı/koruma) kapat — panel stop */
  clearCompanion(reason = "companion temizlendi") {
    this.stopProtectLoop();
    this.companion = defaultCompanion();
    this.followTaskId = null;
    this.attackTaskId = null;
    this.deadPaused = false;
    this.cancelTasksOfType("follow");
    this.cancelTasksOfType("attack");
    this.cancelTasksOfType("defend");
    this.clearPathfinder();
    this.setMode("idle", null);
    this.log().info("Takip/saldırı/koruma kapatıldı", reason);
    this.emitCombat();
  }

  /** Sadece koruma ayarları (dövüş paneli) — listeyi bozmadan */
  updateProtectSettings(opts: Partial<CompanionState["protectSettings"]> & { followDistance?: number }) {
    if (opts.followDistance != null) {
      this.companion.followDistance = Math.max(1, Math.min(16, Math.floor(opts.followDistance)));
    }
    if (opts.range != null) this.companion.protectSettings.range = Math.max(4, Math.min(32, Math.floor(opts.range)));
    if (opts.protectAggro === "threats" || opts.protectAggro === "non_whitelist") {
      this.companion.protectSettings.protectAggro = opts.protectAggro;
    }
    if (opts.retaliateMobs != null) this.companion.protectSettings.retaliateMobs = Boolean(opts.retaliateMobs);
    if (opts.retaliatePlayers != null) this.companion.protectSettings.retaliatePlayers = Boolean(opts.retaliatePlayers);
    if (opts.whitelist) {
      this.companion.protectSettings.whitelist = opts.whitelist.map((w) => w.trim()).filter(Boolean);
    }
    // aktif takip mesafesini yenile
    if (this.companion.followPlayer && !this.deadPaused) {
      this.ensureFollowTask(this.companion.followPlayer, this.companion.followDistance, true);
    }
    this.log().info(
      "Koruma ayarları güncellendi",
      `mod=${this.companion.protectSettings.protectAggro} r=${this.companion.protectSettings.range} mob=${this.companion.protectSettings.retaliateMobs} oyuncu=${this.companion.protectSettings.retaliatePlayers}`
    );
    this.emitCombat();
    return this.getRuntime();
  }

  private clearPathfinder() {
    try {
      const bot = this.bot ?? this.instance.bot;
      if (!bot) return;
      const pf = bot.pathfinder as
        | { setGoal?(g: null): void; stop?(): void; isMoving?(): boolean }
        | undefined;
      try {
        pf?.stop?.();
      } catch {
        /* eski pathfinder */
      }
      try {
        pf?.setGoal?.(null);
      } catch {
        /* */
      }
      for (const k of ["forward", "back", "left", "right", "jump", "sprint"] as const) {
        try {
          bot.setControlState(k, false);
        } catch {
          /* */
        }
      }
    } catch {
      /* */
    }
  }

  // ---- companion toggles (yakındaki oyuncular) --------------------------------

  /**
   * Takip aç/kapa. distance = durma mesafesi (blok).
   * Koruma listesi doluyken takip tamamen kapanmaz: ana kişi değiştirilebilir.
   */
  setFollow(player: string, enabled: boolean, distance?: number) {
    const name = player.trim();
    if (!name) throw new Error("Oyuncu adı boş");
    if (distance != null && Number.isFinite(distance)) {
      this.companion.followDistance = Math.max(1, Math.min(16, Math.floor(distance)));
    }
    if (!enabled) {
      if (this.companion.followPlayer?.toLowerCase() === name.toLowerCase()) {
        if (this.hasProtect()) {
          // koruma açık: takip ana kişiyi listeden tut (aynı kişi veya ilk korunan)
          const fallback =
            this.companion.protectPlayers.find((p) => p.toLowerCase() !== name.toLowerCase()) ??
            this.companion.protectPlayers[0] ??
            null;
          if (fallback) {
            this.companion.followPlayer = fallback;
            this.ensureFollowTask(fallback, this.companion.followDistance, true);
            this.log().info(
              fallback.toLowerCase() === name.toLowerCase()
                ? "Koruma açık — takip kapatılamaz; önce tüm korumaları kapat"
                : `Takip ana kişi değişti (koruma): ${fallback}`
            );
            if (this.hasProtect()) this.setMode("protecting", this.primaryProtectLabel());
            this.emitCombat();
            return this.getRuntime();
          }
        }
        this.companion.followPlayer = null;
        this.cancelTasksOfType("follow");
      }
      this.emitCombat();
      return this.getRuntime();
    }
    // aynı kişiye attack+follow çakışmasın
    if (this.companion.attackPlayer?.toLowerCase() === name.toLowerCase()) {
      this.companion.attackPlayer = null;
      this.cancelTasksOfType("attack");
    }
    this.companion.followPlayer = name;
    this.ensureFollowTask(name, this.companion.followDistance, true);
    this.log().info(`Takip açıldı: ${name} (mesafe ${this.companion.followDistance})`);
    if (this.hasProtect()) this.setMode("protecting", this.primaryProtectLabel());
    this.emitCombat();
    return this.getRuntime();
  }

  setAttack(player: string, enabled: boolean) {
    const name = player.trim();
    if (!name) throw new Error("Oyuncu adı boş");
    if (!enabled) {
      if (this.companion.attackPlayer?.toLowerCase() === name.toLowerCase()) {
        this.companion.attackPlayer = null;
        this.cancelTasksOfType("attack");
        if (this.mode === "attacking") {
          if (this.hasProtect()) this.setMode("protecting", this.primaryProtectLabel());
          else this.setMode("idle", this.companion.followPlayer);
        }
      }
      this.emitCombat();
      return this.getRuntime();
    }
    if (this.isProtectedName(name)) {
      throw new Error("Korunan oyuncuya saldırı açılamaz");
    }
    this.companion.attackPlayer = name;
    // koruma yoksa saldırı takibi kapatır; koruma varsa ana kişi takibi kalır
    if (!this.hasProtect()) {
      this.companion.followPlayer = null;
      this.cancelTasksOfType("follow");
    }
    this.ensureAttackTask(name);
    this.log().info(`Saldırı açıldı: ${name}`);
    this.emitCombat();
    return this.getRuntime();
  }

  /**
   * Koruma aç/kapa (çoklu). enabled=true → listeye ekle;
   * ilk korunan için takip yoksa otomatik takip; ek korunanlar takip değiştirmez.
   */
  setProtect(
    player: string,
    enabled: boolean,
    opts?: Partial<CompanionState["protectSettings"]> & { followDistance?: number; setAsMain?: boolean }
  ) {
    const name = player.trim();
    if (!name) throw new Error("Oyuncu adı boş");
    if (opts?.followDistance != null) {
      this.companion.followDistance = Math.max(1, Math.min(16, Math.floor(opts.followDistance)));
    }
    if (opts) {
      if (opts.range != null) this.companion.protectSettings.range = Math.max(4, Math.min(32, Math.floor(opts.range)));
      if (opts.protectAggro === "threats" || opts.protectAggro === "non_whitelist") {
        this.companion.protectSettings.protectAggro = opts.protectAggro;
      }
      if (opts.retaliateMobs != null) this.companion.protectSettings.retaliateMobs = Boolean(opts.retaliateMobs);
      if (opts.retaliatePlayers != null) this.companion.protectSettings.retaliatePlayers = Boolean(opts.retaliatePlayers);
      if (opts.whitelist) {
        this.companion.protectSettings.whitelist = opts.whitelist.map((w) => w.trim()).filter(Boolean);
      }
    }

    if (!enabled) {
      const before = this.companion.protectPlayers.length;
      this.companion.protectPlayers = this.companion.protectPlayers.filter((p) => p.toLowerCase() !== name.toLowerCase());
      if (this.companion.protectPlayers.length === before) {
        this.emitCombat();
        return this.getRuntime();
      }
      this.log().info(`Koruma listesinden çıkarıldı: ${name}`, `kalan: ${this.companion.protectPlayers.join(", ") || "—"}`);

      if (!this.hasProtect()) {
        this.stopProtectLoop();
        // son koruma kalktı — takip kullanıcıda kalsın istersen; netlik: takip de kapanır
        this.companion.followPlayer = null;
        this.cancelTasksOfType("follow");
        this.setMode("idle", null);
      } else {
        // ana takip bu kişiyse başka korunana kaydır
        if (this.companion.followPlayer?.toLowerCase() === name.toLowerCase()) {
          const next = this.companion.protectPlayers[0]!;
          this.companion.followPlayer = next;
          this.ensureFollowTask(next, this.companion.followDistance, true);
        }
        this.setMode("protecting", this.primaryProtectLabel());
      }
      this.companion.protectPlayer = this.primaryProtectLabel();
      this.emitCombat();
      return this.getRuntime();
    }

    // ekle (yinelenme yok)
    if (!this.isProtectedName(name)) {
      this.companion.protectPlayers.push(name);
    }
    this.companion.protectPlayer = this.primaryProtectLabel();

    if (this.companion.attackPlayer?.toLowerCase() === name.toLowerCase()) {
      this.companion.attackPlayer = null;
      this.cancelTasksOfType("attack");
    }

    // ilk korunan veya setAsMain → ana takip
    const becomeMain = opts?.setAsMain === true || !this.companion.followPlayer;
    if (becomeMain) {
      this.companion.followPlayer = name;
      this.ensureFollowTask(name, this.companion.followDistance, true);
    } else if (this.companion.followPlayer) {
      // ana kişi sabit; takip görevini canlı tut
      this.ensureFollowTask(this.companion.followPlayer, this.companion.followDistance);
    }

    this.startProtectLoop();
    this.setMode("protecting", this.primaryProtectLabel());
    this.log().info(
      `Koruma: ${this.companion.protectPlayers.join(", ")}`,
      `mod=${this.companion.protectSettings.protectAggro} ana=${this.companion.followPlayer ?? "—"} mob=${this.companion.protectSettings.retaliateMobs} oyuncu=${this.companion.protectSettings.retaliatePlayers} wl=${this.companion.protectSettings.whitelist.join(",") || "—"}`
    );
    this.emitCombat();
    return this.getRuntime();
  }

  private ensureFollowTask(player: string, distance: number, force = false) {
    if (this.deadPaused) return;
    const wantLabel = `takip: ${player} (≤${distance})`;
    const cur = this.instance.tasks.currentSummary;
    const q = this.instance.tasks.queueSummaries;
    const already =
      !force &&
      ((cur?.type === "follow" && cur.label === wantLabel) ||
        q.some((t) => t.type === "follow" && t.label === wantLabel));
    if (already) return;
    this.cancelTasksOfType("follow");
    const summary = this.instance.tasks.enqueue(
      {
        type: "follow",
        label: wantLabel,
        priority: PRIORITY.USER,
        params: { player, distance },
        requeueOnPreempt: true
      },
      () => (token, report) => runFollow(this.instance, player, distance, token, report)
    );
    this.followTaskId = summary.id;
  }

  private ensureAttackTask(player: string) {
    const cur = this.instance.tasks.currentSummary;
    const q = this.instance.tasks.queueSummaries;
    if (
      (cur?.type === "attack" && cur.label.includes(player)) ||
      q.some((t) => t.type === "attack" && t.label.includes(player))
    ) {
      return;
    }
    this.cancelTasksOfType("attack");
    const summary = this.enqueueAttackPlayer(player);
    this.attackTaskId = summary.id;
  }

  /** takip/koruma bitişinde doğru moda dön */
  private restoreCompanionMode() {
    if (this.hasProtect()) {
      const follow = this.companion.followPlayer ?? this.companion.protectPlayers[0] ?? null;
      if (follow) {
        this.companion.followPlayer = follow;
        this.ensureFollowTask(follow, this.companion.followDistance);
      }
      this.setMode("protecting", this.primaryProtectLabel());
      return;
    }
    if (this.companion.attackPlayer) {
      this.setMode("attacking", this.companion.attackPlayer);
      this.ensureAttackTask(this.companion.attackPlayer);
      return;
    }
    if (this.companion.followPlayer) {
      this.setMode("idle", this.companion.followPlayer);
      this.ensureFollowTask(this.companion.followPlayer, this.companion.followDistance);
      return;
    }
    this.setMode("idle", null);
  }

  private cancelTasksOfType(type: string) {
    const cur = this.instance.tasks.currentSummary;
    if (cur?.type === type) this.instance.tasks.cancel(cur.id, `${type} kapatıldı`);
    for (const t of this.instance.tasks.queueSummaries) {
      if (t.type === type) this.instance.tasks.cancel(t.id, `${type} kapatıldı`);
    }
  }

  private startProtectLoop() {
    this.stopProtectLoop();
    this.protectTimer = setInterval(() => this.protectTick(), PROTECT_TICK_MS);
  }

  private stopProtectLoop() {
    if (this.protectTimer) {
      clearInterval(this.protectTimer);
      this.protectTimer = null;
    }
  }

  private startSelfGuardLoop() {
    this.stopSelfGuardLoop();
    this.selfGuardTimer = setInterval(() => this.selfGuardTick(), SELF_GUARD_TICK_MS);
  }

  private stopSelfGuardLoop() {
    if (this.selfGuardTimer) {
      clearInterval(this.selfGuardTimer);
      this.selfGuardTimer = null;
    }
  }

  /**
   * Boşta / takipte öz savunma: defendMode açıkken menzildeki hostile (veya
   * bilinen saldırgan oyuncu) → savunun; can düşükse kaç.
   * Eşlik koruması (protectTick) ayrı — ward etrafı; bu botun kendi etrafı.
   */
  private selfGuardTick() {
    if (this.deadPaused) return;
    if (this.instance.status !== "online") return;
    const mode = this.cfg().defendMode;
    if (mode === "off") return;

    const bot = this.bot ?? this.instance.bot;
    if (!bot?.entity) return;
    if ((bot.health ?? 0) <= 0) return;

    // zaten dövüş/kaçış görevi var veya kuyrukta — spam görev açma
    if (this.hasActiveCombatTask()) return;
    if (this.mode === "fleeing" || this.mode === "attacking" || this.mode === "defending") return;

    const range = Math.max(4, Math.min(32, Math.floor(this.cfg().defendRange ?? 12)));
    const target = this.pickSelfGuardTarget(mode, range);
    if (!target) return;

    const label = labelEntity(target);
    const hp = bot.health ?? 20;
    const fleeAt = this.cfg().fleeAtHealth ?? 6;

    if (hp <= fleeAt) {
      this.log().warn(`Öz savunma → kaçış (can ${hp} ≤ ${fleeAt})`, label);
      this.enqueueFlee(label);
      return;
    }

    const dist = bot.entity.position.distanceTo(target.position);
    this.log().info(`Öz savunma: ${label}`, `mod=${mode} r=${range} d=${dist.toFixed(1)} id=${target.id}`);
    this.instance.tasks.enqueue(
      {
        type: "defend",
        label: `öz-savun: ${label}`,
        priority: PRIORITY.DEFENSE,
        params: { target: label, selfGuard: true, entityId: target.id },
        requeueOnPreempt: false
      },
      () => (token, report) => this.runDefend(target, label, token, report)
    );
  }

  /** savun/saldır/kaç aktif veya kuyrukta mı */
  private hasActiveCombatTask(): boolean {
    const types = new Set(["defend", "attack", "flee", "clear-mobs"]);
    const cur = this.instance.tasks.currentSummary;
    if (cur && types.has(cur.type)) return true;
    return this.instance.tasks.queueSummaries.some((t) => types.has(t.type));
  }

  /** Proaktif hedef: hostile mob her zaman; oyuncu yalnız recentThreat */
  private pickSelfGuardTarget(mode: CombatConfig["defendMode"], range: number): Entity | null {
    const bot = this.bot ?? this.instance.bot;
    if (!bot?.entity || mode === "off") return null;
    this.pruneThreats();

    let best: Entity | null = null;
    let bestD = range + 0.01;

    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      if (this.isTargetTemporarilyUnreachable(e)) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d > range) continue;

      const player = isPlayerEntity(e);
      const hostile = isHostileMob(String(e.name ?? e.displayName ?? ""));
      const elabel = labelEntity(e);

      if (player) {
        if (mode !== "player" && mode !== "all") continue;
        if (e.username && e.username === bot.username) continue;
        // korunan / takip edilene asla
        if (e.username && this.isProtectedName(e.username)) continue;
        if (this.companion.followPlayer && e.username?.toLowerCase() === this.companion.followPlayer.toLowerCase()) {
          continue;
        }
        if (!this.isRecentThreat(elabel) && !(e.username && this.isRecentThreat(e.username))) continue;
      } else if (hostile) {
        if (mode !== "mob" && mode !== "all") continue;
      } else continue;

      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * Tüm korunanların yanındaki hedefleri tara → DEFENSE.
   * protectAggro:
   *  - threats: saldırgan tehdit (hostile mob + yakın düşman oyuncu)
   *  - non_whitelist: beyaz listede olmayan her oyuncu (+ mob opsiyonel)
   */
  private protectTick() {
    if (this.deadPaused) return;
    if (!this.hasProtect() || this.instance.status !== "online") return;
    const bot = this.bot ?? this.instance.bot;
    if (!bot?.entity) return;
    // ölüm animasyonu / can 0
    if ((bot.health ?? 0) <= 0) return;

    this.pruneThreats();

    // ana takip: followPlayer veya ilk korunan
    const main = this.companion.followPlayer ?? this.companion.protectPlayers[0]!;
    if (!this.companion.followPlayer) this.companion.followPlayer = main;
    this.ensureFollowTask(main, this.companion.followDistance);

    const settings = this.companion.protectSettings;
    const aggro = settings.protectAggro === "non_whitelist" ? "non_whitelist" : "threats";
    const wl = new Set(settings.whitelist.map((w) => w.toLowerCase()));
    for (const p of this.companion.protectPlayers) wl.add(p.toLowerCase());
    wl.add(bot.username.toLowerCase());

    // korunan entity'ler (görünenler)
    const wardEntities: { name: string; ent: Entity }[] = [];
    for (const name of this.companion.protectPlayers) {
      const ent = bot.players[name]?.entity;
      if (ent) wardEntities.push({ name, ent });
    }
    if (!wardEntities.length) return;

    let best: Entity | null = null;
    let bestD = settings.range + 0.01;
    let bestWard = wardEntities[0]!.name;

    for (const { name: wardName, ent: wardEnt } of wardEntities) {
      for (const id in bot.entities) {
        const e = bot.entities[id];
        if (!e || e === bot.entity) continue;
      if (this.isTargetTemporarilyUnreachable(e)) continue;
        if (wardEntities.some((w) => w.ent === e)) continue;
        const d = wardEnt.position.distanceTo(e.position);
        if (d > settings.range) continue;

        const player = isPlayerEntity(e);
        const hostile = isHostileMob(String(e.name ?? e.displayName ?? ""));
        const uname = (e.username ?? "").toLowerCase();
        const elabel = labelEntity(e);

        if (player) {
          if (uname && wl.has(uname)) continue;
          if (!settings.retaliatePlayers) continue;
          if (aggro === "non_whitelist") {
            // beyaz liste dışı her oyuncu
          } else {
            // threats: yalnızca botu vurmuş / kayıtlı saldırgan oyuncu
            if (!this.isRecentThreat(elabel) && !(uname && this.isRecentThreat(uname))) continue;
          }
        } else if (hostile) {
          if (!settings.retaliateMobs) continue;
        } else continue;

        if (d < bestD) {
          bestD = d;
          best = e;
          bestWard = wardName;
        }
      }
    }

    if (!best) return;
    const label = labelEntity(best);
    const cur = this.instance.tasks.currentSummary;
    if (cur?.type === "defend" || cur?.type === "attack") return;

    this.instance.tasks.enqueue(
      {
        type: "defend",
        label: `koru(${bestWard}/${aggro})→${label}`,
        priority: PRIORITY.DEFENSE,
        params: { target: label, ward: bestWard, aggro },
        requeueOnPreempt: false
      },
      () => (token, report) => this.runDefend(best!, label, token, report)
    );
  }

  /** Enqueue user attack-on-player task */
  enqueueAttackPlayer(playerName: string) {
    const name = playerName.trim();
    if (!name) throw new Error("Oyuncu adı boş olamaz");
    return this.instance.tasks.enqueue(
      {
        type: "attack",
        label: `saldır: ${name}`,
        priority: PRIORITY.USER,
        params: { player: name },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runAttackPlayer(name, token, report)
    );
  }

  enqueueClearMobs(radius = 16) {
    const r = Math.max(4, Math.min(48, Math.floor(radius)));
    return this.instance.tasks.enqueue(
      {
        type: "clear-mobs",
        label: `mob temizle (r=${r})`,
        priority: PRIORITY.USER,
        params: { radius: r },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runClearMobs(r, token, report)
    );
  }

  enqueueFlee(fromLabel?: string) {
    return this.instance.tasks.enqueue(
      {
        type: "flee",
        label: "kaçış (can kritik)",
        priority: PRIORITY.SURVIVAL,
        params: { from: fromLabel ?? null },
        requeueOnPreempt: false
      },
      () => (token, report) => this.runFlee(fromLabel, token, report)
    );
  }

  enqueueLootDeath() {
    const d = this.lastDeath;
    if (!d) throw new Error("Kayıtlı ölüm konumu yok");
    if (Date.now() > d.lootUntil) throw new Error("Ölüm eşyaları despawn olmuş olabilir (~5 dk geçti)");
    return this.instance.tasks.enqueue(
      {
        type: "loot-death",
        label: "ölüm yerinden loot",
        priority: PRIORITY.USER,
        params: { ...d },
        requeueOnPreempt: true
      },
      () => (token, report) => this.runLootDeath(d, token, report)
    );
  }

  // ---- internal loops -------------------------------------------------------

  private async runAttackPlayer(playerName: string, token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    this.setMode("attacking", playerName);

    try {
      // D6 reaction once at start
      await sleep(randomReactionMs(this.cfg()));
      if (token.cancelled) throw new Error(token.reason ?? "iptal");

      await this.equipBestWeapon(true);

      const chase = this.cfg().chaseDistance ?? 24;
      const started = Date.now();
      const maxMs = 5 * 60_000;

      while (!token.cancelled && Date.now() - started < maxMs) {
        if ((bot.health ?? 20) <= (this.cfg().fleeAtHealth ?? 6)) {
          this.log().warn("Can kritik — saldırı bırakılıp kaçışa geçiliyor");
          this.enqueueFlee(playerName);
          throw new Error("Can kritik, kaçış tetiklendi");
        }

        const entity = bot.players[playerName]?.entity;
        if (entity && this.isTargetTemporarilyUnreachable(entity)) {
          report({ done: 0, total: 1, label: playerName + " geçici olarak ulaşılamıyor" });
          await sleep(500);
          continue;
        }
        if (!entity) {
          const inTab = Boolean(bot.players[playerName]);
          report({
            done: 0,
            total: 1,
            label: inTab ? `${playerName} menzil dışında — aranıyor` : `${playerName} görünmüyor`
          });
          if (!inTab) {
            this.log().info(`Saldırı hedefi bulunamadı: ${playerName} (tab listesinde yok)`, "İ1 — sohbete yazılmadı");
            // toggle açık kalsın; kısa bekleyip yeniden dene (görev biter, requeue)
            break;
          }
          await sleep(1000);
          continue;
        }

        const dist = distanceEyeToEntity(bot, entity);
        report({ done: 0, total: Math.max(1, Math.round(dist)), label: `${playerName} · ${dist.toFixed(1)} blok` });

        if (dist > chase) {
          this.log().info(`Hedef ${chase} bloktan uzak — kovalama bırakıldı`);
          break;
        }

        if (!inMeleeRange(bot, entity, this.cfg().reach)) {
          await this.approachEntity(entity, Math.max(1, (this.cfg().reach ?? 3) - 0.5), token);
          continue;
        }

        await this.ensureCombatWeapon();
        const res = await tryRealisticAttack(bot, entity, this.cfg(), this.lastSwing, token);
        if (res.ok) {
          report({ done: 1, total: 1, label: `vuruş: ${playerName}` });
        } else if (res.reason === "los" || res.reason === "range") {
          await this.approachEntity(entity, 2, token);
        } else if (res.reason === "cancelled") {
          throw new Error(res.detail ?? token.reason ?? "iptal");
        }

        if (entity.health !== undefined && entity.health <= 0) break;

        await sleep(50);
      }

      if (token.cancelled) throw new Error(token.reason ?? "iptal");
      report({ done: 1, total: 1, label: `saldırı bitti: ${playerName}` });
    } finally {
      // basılı toggle: iptal değilse kısa gecikmeyle yeniden kuyruk
      if (!token.cancelled && this.companion.attackPlayer?.toLowerCase() === playerName.toLowerCase()) {
        setTimeout(() => {
          if (this.companion.attackPlayer?.toLowerCase() === playerName.toLowerCase()) {
            this.ensureAttackTask(playerName);
            this.setMode("attacking", playerName);
          }
        }, 1200);
      } else if (!token.cancelled) {
        this.restoreCompanionMode();
      }
    }
  }

  private async runClearMobs(radius: number, token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    this.setMode("attacking", "moblar");
    await sleep(randomReactionMs(this.cfg()));
    await this.equipBestWeapon(true);

    let killed = 0;
    const started = Date.now();

    while (!token.cancelled && Date.now() - started < 10 * 60_000) {
      if ((bot.health ?? 20) <= (this.cfg().fleeAtHealth ?? 6)) {
        this.enqueueFlee("mob");
        throw new Error("Can kritik, kaçış tetiklendi");
      }

      const target = this.nearestHostile(radius);
      if (!target) {
        report({ done: killed, total: killed, label: `temiz · ${killed} mob` });
        break;
      }

      const name = labelEntity(target);
      this.activeTargetLabel = name;
      this.emitCombat();
      report({ done: killed, total: killed + 1, label: `hedef: ${name}` });

      // creeper standoff
      const ename = (target.name ?? target.displayName ?? "").toString().replace(/^minecraft:/, "");
      const wantRange =
        ename === "creeper" ? CREEPER_SAFE_RANGE : Math.max(1, (this.cfg().reach ?? 3) - 0.4);

      if (!inMeleeRange(bot, target, this.cfg().reach) || (ename === "creeper" && distanceEyeToEntity(bot, target) < 3)) {
        if (ename === "creeper" && distanceEyeToEntity(bot, target) < 3) {
          await this.fleeFrom(target.position, 6, token);
        } else {
          await this.approachEntity(target, wantRange, token);
        }
        continue;
      }

      const res = await tryRealisticAttack(bot, target, this.cfg(), this.lastSwing, token);
      if (res.ok) {
        /* swing landed */
      } else if (res.reason === "los" || res.reason === "range") {
        await this.approachEntity(target, 2, token);
      }

      if (!target.isValid || (target.health !== undefined && target.health <= 0)) {
        killed++;
      }
      await sleep(HOSTILE_SCAN_MS);
    }

    this.setMode("idle", null);
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    this.log().success(`Mob temizliği bitti (${killed} hedef işlendi)`);
  }

  private async runFlee(fromLabel: string | undefined, token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    this.setMode("fleeing", fromLabel ?? null);
    report({ done: 0, total: 1, label: "kaçılıyor…" });

    let fromPos = bot.entity.position.clone();
    if (fromLabel) {
      const e = this.findEntityByLabel(fromLabel);
      if (e) fromPos = e.position.clone();
    } else {
      const near = this.nearestHostile(12) || this.nearestPlayerEntity(12);
      if (near) fromPos = near.position.clone();
    }

    await this.fleeFrom(fromPos, 18, token);
    // wait until health recovers a bit or timeout
    const t0 = Date.now();
    while (!token.cancelled && Date.now() - t0 < 30_000) {
      if ((bot.health ?? 0) > (this.cfg().fleeAtHealth ?? 6) + 4) break;
      report({ done: 0, total: 1, label: `kaçış · can ${bot.health?.toFixed?.(0) ?? "?"}` });
      await sleep(500);
    }

    this.setMode("idle", null);
    report({ done: 1, total: 1, label: "kaçış tamam" });
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
  }

  private async runLootDeath(d: DeathRecord, token: TaskToken, report: ProgressFn) {
    const bot = this.requireBot();
    if (this.instance.runtime.dimension !== d.dimension) {
      throw new Error(`Ölüm ${d.dimension} boyutunda, bot ${this.instance.runtime.dimension} — önce boyut değiştir`);
    }
    report({ done: 0, total: 1, label: "ölüm noktasına gidiliyor" });
    await runGoto(this.instance, d.x, d.y, d.z, 2, token, report);
    this.log().info("Ölüm noktasına varıldı — yerdeki eşyalar için yakında kalın (otomatik pickup sunucuya bağlı)");
    // brief wait for vanilla pickup
    await sleep(3000);
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    report({ done: 1, total: 1, label: "loot denemesi bitti" });
  }

  // ---- defense / death ------------------------------------------------------

  private onHealthChange() {
    const bot = this.bot;
    if (!bot || this.instance.status !== "online") return;
    const hp = bot.health ?? 20;

    // death event gecikebilir — can 0'da hemen pathfinder/koruma dondur
    if (hp <= 0) {
      this.lastHealth = 0;
      if (!this.deadPaused) this.onDeath();
      else this.clearPathfinder();
      return;
    }

    if (this.deadPaused) return;
    const dropped = hp < this.lastHealth - 0.05;
    this.lastHealth = hp;

    if (!dropped) return;

    this.pruneThreats();
    const mode = this.cfg().defendMode;
    // otomasyon her zaman (savunma kapalı olsa da) saldırgan adayını dener
    const attackerForRules = this.pickDefenseTarget(mode === "off" ? "all" : mode);
    if (attackerForRules) {
      const label0 = labelEntity(attackerForRules);
      const isPlayer = Boolean(attackerForRules.username) || attackerForRules.type === "player";
      // koruma "threats" modu için saldırganı kaydet
      this.markThreat(label0);
      if (attackerForRules.username) this.markThreat(attackerForRules.username);
      this.instance.emit("attacked", {
        botId: this.instance.config.id,
        attacker: label0,
        source: isPlayer ? ("player" as const) : ("mob" as const)
      });
    }

    if (mode === "off") {
      if (hp <= (this.cfg().fleeAtHealth ?? 6) && this.mode !== "fleeing") {
        if (this.mode === "attacking" || this.mode === "defending") {
          this.enqueueFlee();
        }
      }
      return;
    }

    if (hp <= (this.cfg().fleeAtHealth ?? 6)) {
      if (this.mode !== "fleeing") {
        this.log().warn(`Can ${hp} ≤ kaçış eşiği — savunma yerine kaçış`);
        this.enqueueFlee();
      }
      return;
    }

    const attacker = attackerForRules ?? this.pickDefenseTarget(mode);
    if (!attacker) return;

    const label = labelEntity(attacker);
    // don't stack infinite defense tasks
    if (this.hasActiveCombatTask()) return;
    if (this.mode === "defending" && this.activeTargetLabel === label) return;

    this.log().info(`Savunma: ${label} (mod=${mode})`);
    this.instance.tasks.enqueue(
      {
        type: "defend",
        label: `savun: ${label}`,
        priority: PRIORITY.DEFENSE,
        params: { target: label, entityId: attacker.id },
        requeueOnPreempt: false
      },
      () => (token, report) => this.runDefend(attacker, label, token, report)
    );
  }

  private async runDefend(initial: Entity, label: string, token: TaskToken, report: ProgressFn) {
    // kısa tepki — 300ms+ beklerken zombi vuruyor; öz savunmada hızlı ol
    const react = Math.min(120, randomReactionMs(this.cfg()));
    await sleep(react);
    if (token.cancelled) throw new Error(token.reason ?? "iptal");

    this.setMode("defending", label);
    await this.equipBestWeapon(true);

    // chaseDistance 0/bozuksa yine de dövüşü terk etme
    const chase = Math.max(12, Number(this.cfg().chaseDistance) || 24);
    const t0 = Date.now();
    let targetId: number | null = typeof initial?.id === "number" ? initial.id : null;
    let lostSince: number | null = null;
    let hits = 0;
    let lastWeaponCheck = 0;

    try {
      while (!token.cancelled && Date.now() - t0 < 120_000) {
        if ((this.bot?.health ?? 20) <= (this.cfg().fleeAtHealth ?? 6)) {
          this.enqueueFlee(label);
          throw new Error("Can kritik");
        }

        const bot = this.requireBot();
        if (!bot.entity) break;

        // su/build koruması el değiştirebilir — periyodik silah
        if (Date.now() - lastWeaponCheck > 400) {
          lastWeaponCheck = Date.now();
          await this.ensureCombatWeapon();
        }

        // 1) entity id  2) en yakın aynı etiket  3) en yakın uygun tehdit
        let entity =
          this.resolveCombatEntity(targetId, label, chase + 4) ??
          this.pickSelfGuardTarget(this.cfg().defendMode === "off" ? "all" : this.cfg().defendMode, chase) ??
          (initial && initial.isValid !== false && !this.isTargetTemporarilyUnreachable(initial) ? initial : null);

        if (!entity || entity.isValid === false) {
          if (lostSince == null) lostSince = Date.now();
          // kısa grace — entity paket gecikmesi
          if (Date.now() - lostSince > 2000) {
            this.log().info("Saldırgan kayboldu — savunma bitti", label);
            break;
          }
          report({ done: 0, total: 1, label: `savun ${label} · aranıyor` });
          await sleep(150);
          continue;
        }
        lostSince = null;
        if (typeof entity.id === "number") targetId = entity.id;

        // gövde mesafesi (göz-aim bazen 1.21'de şişebilir; kovalama için feet)
        const dist = bot.entity.position.distanceTo(entity.position);
        report({
          done: hits,
          total: Math.max(hits + 1, 1),
          label: `savun ${labelEntity(entity)} · ${dist.toFixed(1)}m${hits ? ` · ${hits} vuruş` : ""}`
        });

        if (dist > chase) {
          // yanlış uzak entity seçildiyse en yakını dene, hemen vazgeçme
          const nearer =
            this.findNearestByLabel(label, chase) ??
            this.pickSelfGuardTarget(this.cfg().defendMode === "off" ? "mob" : this.cfg().defendMode, chase);
          if (!nearer) {
            this.log().info("Saldırgan menzilden çıktı — kovalama bırakıldı", `${dist.toFixed(1)}>${chase}`);
            break;
          }
          entity = nearer;
          if (typeof entity.id === "number") targetId = entity.id;
        }

        if (entity.health !== undefined && entity.health <= 0) {
          this.log().info(`Hedef öldü: ${labelEntity(entity)}`);
          break;
        }

        const reach = this.cfg().reach ?? 3;
        if (!inMeleeRange(bot, entity, reach)) {
          await this.approachEntity(entity, Math.max(1.15, reach - 0.7), token);
          continue;
        }

        await this.ensureCombatWeapon();
        const res = await tryRealisticAttack(bot, entity, this.cfg(), this.lastSwing, token);
        if (res.ok) {
          hits += 1;
          if (entity.health !== undefined && entity.health <= 0) break;
        } else if (res.reason === "range" || res.reason === "los") {
          await this.approachEntity(entity, Math.max(1.15, reach - 0.7), token);
        } else if (res.reason === "cancelled") {
          throw new Error(res.detail ?? token.reason ?? "iptal");
        }

        await sleep(50);
      }

      if (token.cancelled) throw new Error(token.reason ?? "iptal");
      if (hits > 0) this.log().info(`Savunma bitti: ${label}`, `${hits} vuruş`);
    } finally {
      this.clearPathfinder();
      this.restoreCompanionMode();
    }
  }

  private onDeath() {
    // çift tetik (health=0 + death event) güvenli
    if (this.deadPaused && this.lastDeath && Date.now() - this.lastDeath.ts < 2000) {
      this.clearPathfinder();
      return;
    }

    const pos = this.instance.runtime.position;
    const dimension = this.instance.runtime.dimension;
    const ts = Date.now();
    this.lastDeath = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      dimension,
      ts,
      lootUntil: ts + DEATH_LOOT_MS
    };

    // koruma/takip pathfinder'ı öldükten sonra kilitliyor — dondur, ayarları sakla
    this.deadPaused = true;
    this.stopProtectLoop();
    // selfGuardTimer tick deadPaused ile no-op; pathfinder yine temizle
    for (const t of ["follow", "attack", "defend", "clear-mobs", "flee"] as const) {
      this.cancelTasksOfType(t);
    }
    // aktif hareket görevi de (goto / goto-player vb.) pathfinder tutmasın
    const cur = this.instance.tasks.currentSummary;
    if (
      cur &&
      ["follow", "attack", "defend", "clear-mobs", "flee", "goto", "goto-player", "move"].includes(cur.type)
    ) {
      this.instance.tasks.cancel(cur.id, "ölüm — hareket durdu");
    }
    this.clearPathfinder();
    // pathfinder async bırakmasın diye bir kez daha
    setTimeout(() => this.clearPathfinder(), 50);
    setTimeout(() => this.clearPathfinder(), 250);
    this.setMode("idle", null);

    this.log().warn(
      "Bot öldü — ölüm konumu kaydedildi",
      `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} (${dimension}) · loot ~5 dk · koruma/takip respawn'a kadar durdu`
    );
    this.instance.emit("deathAt", {
      botId: this.instance.config.id,
      username: this.instance.config.username,
      serverId: this.instance.config.serverId,
      x: this.lastDeath.x,
      y: this.lastDeath.y,
      z: this.lastDeath.z,
      dimension: this.lastDeath.dimension,
      ts: this.lastDeath.ts,
      lootUntil: this.lastDeath.lootUntil
    });
    this.emitCombat();
  }

  // ---- helpers --------------------------------------------------------------

  /** Hasar alınca saldırgan adayı (reaktif) — en yakın uygun hedef */
  private pickDefenseTarget(mode: CombatConfig["defendMode"]): Entity | null {
    if (mode === "off") return null;
    const bot = this.bot;
    if (!bot?.entity) return null;
    const range = Math.max(4, Math.min(32, Math.floor(this.cfg().defendRange ?? 12)));
    const candidates: Entity[] = [];
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      if (this.isTargetTemporarilyUnreachable(e)) continue;
      const dist = bot.entity.position.distanceTo(e.position);
      if (dist > range) continue;
      if (e.username && this.isProtectedName(e.username)) continue;
      if (this.companion.followPlayer && e.username?.toLowerCase() === this.companion.followPlayer.toLowerCase()) {
        continue;
      }
      const player = isPlayerEntity(e);
      const hostile = isHostileMob(String(e.name ?? e.displayName ?? ""));
      if (mode === "player" && player) candidates.push(e);
      else if (mode === "mob" && hostile) candidates.push(e);
      else if (mode === "all" && (player || hostile)) candidates.push(e);
    }
    candidates.sort(
      (a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)
    );
    return candidates[0] ?? null;
  }

  private nearestHostile(radius: number): Entity | null {
    const bot = this.bot;
    if (!bot) return null;
    let best: Entity | null = null;
    let bestD = radius;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      if (this.isTargetTemporarilyUnreachable(e)) continue;
      if (!isHostileMob(String(e.name ?? e.displayName ?? ""))) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private nearestPlayerEntity(radius: number): Entity | null {
    const bot = this.bot;
    if (!bot) return null;
    let best: Entity | null = null;
    let bestD = radius;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity || !isPlayerEntity(e)) continue;
      if (e.username && e.username === bot.username) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private findEntityByLabel(label: string): Entity | null {
    // geriye uyum — en yakını tercih et (ilk rastgele entity değil!)
    return this.findNearestByLabel(label, 64);
  }

  /**
   * Aynı etiketli (zombie / oyuncu adı) en yakın entity.
   * Eski findEntityByLabel ilk map girdisini alıyordu → uzak zombie seçilip
   * "menzilden çıktı" spam'i oluşuyordu.
   */
  private findNearestByLabel(label: string, maxDist: number): Entity | null {
    const bot = this.bot ?? this.instance.bot;
    if (!bot?.entity || !label) return null;
    const want = label.toLowerCase();

    let playerEnt = bot.players[label]?.entity ?? null;
    if (!playerEnt) {
      for (const name of Object.keys(bot.players)) {
        if (name.toLowerCase() === want) {
          playerEnt = bot.players[name]?.entity ?? null;
          break;
        }
      }
    }
    if (playerEnt && !this.isTargetTemporarilyUnreachable(playerEnt)) {
      try {
        const d = bot.entity.position.distanceTo(playerEnt.position);
        if (d <= maxDist) return playerEnt;
      } catch {
        /* */
      }
    }

    let best: Entity | null = null;
    let bestD = maxDist + 0.001;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      if (this.isTargetTemporarilyUnreachable(e)) continue;
      if (labelEntity(e).toLowerCase() !== want) continue;
      if (e.isValid === false) continue;
      try {
        const d = bot.entity.position.distanceTo(e.position);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      } catch {
        /* position yok */
      }
    }
    return best;
  }

  /** id ile tut, yoksa en yakın label */
  private resolveCombatEntity(id: number | null, label: string, maxDist: number): Entity | null {
    const bot = this.bot ?? this.instance.bot;
    if (!bot?.entity) return null;

    if (id != null) {
      const byId = bot.entities[id];
      if (byId && byId.isValid !== false && !this.isTargetTemporarilyUnreachable(byId)) {
        try {
          const d = bot.entity.position.distanceTo(byId.position);
          if (d <= maxDist) return byId;
        } catch {
          /* */
        }
      }
    }
    return this.findNearestByLabel(label, maxDist);
  }

  private async approachEntity(entity: Entity, range: number, token: TaskToken) {
    if (this.deadPaused) return;
    const bot = this.requireBot();
    if ((bot.health ?? 0) <= 0 || !bot.entity) return;
    if (this.isTargetTemporarilyUnreachable(entity)) {
      await sleep(180);
      return;
    }

    const hold = Math.max(0.8, range);
    const chaseLimit = Math.max(12, Number(this.cfg().chaseDistance) || 24);
    let tracked: Entity =
      (typeof entity.id === "number" ? bot.entities[entity.id] : undefined) ?? entity;
    let lastBotPos = bot.entity.position.clone();
    let lastTargetPos = tracked.position.clone();
    let bestDistance = bot.entity.position.distanceTo(tracked.position);
    let lastProgressAt = Date.now();
    let routeRetried = false;
    let noPathSince = 0;

    const setFollowGoal = (target: Entity) => {
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, hold), true);
      } catch {
        const p = target.position;
        bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, hold));
      }
    };

    const onPathUpdate = (result: { status?: string }) => {
      const status = String(result?.status ?? "");
      if (status === "noPath" || status === "timeout") {
        if (!noPathSince) noPathSince = Date.now();
      } else if (status === "success" || status === "partial") {
        noPathSince = 0;
      }
    };

    try {
      // Savaş hedefi kapalı/yer altında olabilir: pathfinder kontrollü biçimde kazabilir.
      // Blok yerleştirme kapalı tutulur; rastgele scaffold ile harita bozulmaz.
      ensureMovement(this.instance, {
        mode: "goto",
        allowSprintNow: true,
        parkour: true,
        canDig: true,
        allowPlace: false
      });

      bot.on("path_update", onPathUpdate);
      setFollowGoal(tracked);
      const startedAt = Date.now();

      while (!token.cancelled && !this.deadPaused && Date.now() - startedAt < 15_000) {
        if ((bot.health ?? 0) <= 0 || !bot.entity) break;

        const live = typeof entity.id === "number" ? bot.entities[entity.id] : tracked;
        if (!live || live.isValid === false) break;
        if (live !== tracked) {
          tracked = live;
          lastTargetPos = live.position.clone();
          setFollowGoal(tracked);
        }

        const now = Date.now();
        const dist = bot.entity.position.distanceTo(live.position);
        const targetJump = live.position.distanceTo(lastTargetPos);

        // Admin TP / anlık uzak taşıma: eski hedef konumuna sonsuza kadar rota çizme.
        if (targetJump >= TARGET_TELEPORT_DELTA && dist > chaseLimit + 4) {
          this.markTargetUnreachable(live, "hedef ışınlandı (" + targetJump.toFixed(1) + " blok)", 8_000);
          break;
        }
        if (dist > chaseLimit + 8) {
          this.markTargetUnreachable(live, "kovalama sınırı dışında (" + dist.toFixed(1) + ">" + (chaseLimit + 8) + ")", 8_000);
          break;
        }

        const reach = this.cfg().reach ?? 3;
        if (inMeleeRange(bot, live, reach)) {
          this.clearTargetUnreachable(live);
          break;
        }

        const moved = bot.entity.position.distanceTo(lastBotPos);
        const improved = bestDistance - dist;
        if (moved > 0.35 || improved > 0.45) {
          lastBotPos = bot.entity.position.clone();
          bestDistance = Math.min(bestDistance, dist);
          lastProgressAt = now;
          routeRetried = false;
          if (noPathSince && now - noPathSince < 800) noPathSince = 0;
        }

        const stalledFor = now - lastProgressAt;
        const noPathFor = noPathSince ? now - noPathSince : 0;

        if (!routeRetried && (stalledFor >= APPROACH_STALL_RETRY_MS || noPathFor >= 1_500)) {
          routeRetried = true;
          lastProgressAt = now;
          noPathSince = 0;
          ensureMovement(this.instance, {
            mode: "goto",
            allowSprintNow: true,
            parkour: true,
            canDig: true,
            allowPlace: false
          });
          setFollowGoal(live);
          this.log().debug("Savaş rotası yeniden hesaplandı", labelEntity(live));
        } else if (stalledFor >= APPROACH_STALL_ABORT_MS || noPathFor >= 4_000) {
          this.markTargetUnreachable(
            live,
            noPathFor >= 4_000 ? "güvenli rota bulunamadı" : "ilerleme yok / blok kırılamıyor"
          );
          break;
        }

        // Aktif rota boyunca yaw pathfinder'a aittir. Yalnızca gerçekten durunca bak.
        try {
          const pf = bot.pathfinder as unknown as { isMoving?(): boolean };
          const vx = bot.entity.velocity?.x ?? 0;
          const vz = bot.entity.velocity?.z ?? 0;
          if (pf.isMoving?.() === false && Math.hypot(vx, vz) < 0.03 && bot.entity.onGround) {
            await stepLookAtEntity(bot, live, this.cfg().turnSpeedDegPerTick ?? 24);
          }
        } catch {
          /* bakış zorunlu değil */
        }

        lastTargetPos = live.position.clone();
        await sleep(100);
      }
    } catch (error) {
      this.log().debug("Yaklaşma başarısız", error instanceof Error ? error.message : String(error));
      if (tracked?.isValid !== false) this.markTargetUnreachable(tracked, "pathfinder hatası", 6_000);
    } finally {
      try {
        bot.removeListener("path_update", onPathUpdate);
      } catch {
        /* */
      }
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* */
      }
      // Eski pathfinder kontrol paketleri boşalsın; sonraki vuruş bakışıyla çakışmasın.
      await sleep(60);
    }
  }

private async fleeFrom(from: { x: number; y: number; z: number }, dist: number, token: TaskToken) {
    const bot = this.requireBot();
    const pos = bot.entity.position;
    const dx = pos.x - from.x;
    const dz = pos.z - from.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const tx = pos.x + (dx / len) * dist;
    const tz = pos.z + (dz / len) * dist;
    const ty = pos.y;
    try {
      await runGoto(this.instance, tx, ty, tz, 2, token, () => {});
    } catch {
      /* path fail — still ok for flee attempt */
    }
  }

  /**
   * Dövüşte mutlaka silah/balta (veya en iyi yedek).
   * Toprak/kova/yemek elde kalmasın — su/build koruması el değiştirebilir.
   */
  async equipBestWeapon(force = false): Promise<void> {
    const bot = this.bot ?? this.instance.bot;
    if (!bot) return;
    this.bot = bot;
    const banned = this.instance.config.inventory.bannedItems;
    const items = bot.inventory.items();
    const names = items.map((i) => i.name);
    const best = pickBestWeaponName(names, banned);
    const held = bot.heldItem?.name;

    // zaten en iyi silah
    if (best && held === best && !force) return;

    // elde silah var ve en iyisi yoksa (veya sadece alet) — silah tercih
    if (!best) {
      // silah/alet yok — en azından blok bırak (yumruk)
      if (held && isBadCombatHeld(held) && !isMeleeWeapon(held)) {
        try {
          await bot.unequip("hand");
          this.log().info("Dövüş: el boşaltıldı (silah yok, blok/toprak bırakıldı)");
        } catch {
          /* */
        }
      }
      return;
    }

    if (banned.includes(best)) {
      this.log().warn(`En iyi silah yasaklı listede: ${best}`);
      return;
    }

    // elde zaten silah ve best alet yedekse — kılıç tercih et (best zaten en yüksek skor)
    if (held === best) return;

    const item = items.find((i) => i.name === best);
    if (!item) return;

    for (let tryN = 0; tryN < 3; tryN++) {
      try {
        await bot.equip(item, "hand");
        await sleep(30);
        if (bot.heldItem?.name === best) {
          if (tryN > 0 || force || isBadCombatHeld(held)) {
            this.log().info(`Dövüş silahı: ${best}`, held && held !== best ? `önceki: ${held}` : undefined);
          }
          return;
        }
      } catch (e) {
        this.log().debug("Silah kuşanma denemesi", e instanceof Error ? e.message : String(e));
        await sleep(40);
      }
    }
    this.log().warn("Silah kuşanılamadı", `${best} · elde: ${bot.heldItem?.name ?? "boş"}`);
  }

  /** Saldırı öncesi: kötü elde silah yoksa zorla kuşan */
  private async ensureCombatWeapon(): Promise<void> {
    const bot = this.bot ?? this.instance.bot;
    if (!bot) return;
    const held = bot.heldItem?.name;
    if (held && isMeleeWeapon(held)) return;
    await this.equipBestWeapon(true);
  }

  private requireBot(): Bot {
    const bot = this.bot ?? this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot çevrimdışı — dövüş yapılamaz");
    this.bot = bot;
    return bot;
  }
}

// caya-rubberband-fix-v1: pathfinder durduktan sonra bakış sistemine güvenli devir.
const caya_rubberband_fix_v1_combat = true;
async function waitForPathfinderIdle(bot: Bot, token: TaskToken, maxMs = 180): Promise<void> {
  const until = Date.now() + Math.max(40, maxMs);
  while (!token.cancelled && Date.now() < until) {
    try {
      const pf = bot.pathfinder as unknown as { isMoving?(): boolean };
      const vx = bot.entity?.velocity?.x ?? 0;
      const vz = bot.entity?.velocity?.z ?? 0;
      if (pf.isMoving?.() === false && Math.hypot(vx, vz) < 0.03) return;
    } catch {
      return;
    }
    await sleep(20);
  }
}

function labelEntity(e: Entity): string {
  if (e.username) return e.username;
  const n = String(e.name ?? e.displayName ?? "entity").replace(/^minecraft:/, "");
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { pickBestWeaponName, weaponScore, cooldownMsForWeapon } from "./weapons";
export { isHostileMob } from "./mobs";
export { tryRealisticAttack, hasLineOfSight, inMeleeRange } from "./realism";

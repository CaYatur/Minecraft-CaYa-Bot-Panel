import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import type { CombatConfig, CombatRuntime, CompanionState, DeathRecord } from "../../types";
import { goals } from "mineflayer-pathfinder";
import { ensureMovement, runFollow, runGoto, stopMovement } from "../movement";
import { CREEPER_SAFE_RANGE, isHostileMob, isPlayerEntity } from "./mobs";
import {
  distanceEyeToEntity,
  inMeleeRange,
  randomReactionMs,
  tryRealisticAttack
} from "./realism";
import { pickBestWeaponName } from "./weapons";

const DEATH_LOOT_MS = 5 * 60 * 1000;
const HOSTILE_SCAN_MS = 400;
const PROTECT_TICK_MS = 600;

const defaultCompanion = (): CompanionState => ({
  followPlayer: null,
  followDistance: 3,
  attackPlayer: null,
  protectPlayers: [],
  protectPlayer: null,
  protectSettings: {
    range: 10,
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
  private followTaskId: string | null = null;
  private attackTaskId: string | null = null;

  constructor(private readonly instance: BotInstance) {}

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

    // reconnect sonrası companion görevlerini yeniden başlat
    if (this.hasProtect()) this.startProtectLoop();
    else if (this.companion.followPlayer) this.ensureFollowTask(this.companion.followPlayer, this.companion.followDistance);
    if (this.companion.attackPlayer) this.ensureAttackTask(this.companion.attackPlayer);

    this.emitCombat();
  }

  /** detach bot listeners but keep companion settings for reconnect */
  private detachKeepCompanion() {
    if (this.protectTimer) {
      clearInterval(this.protectTimer);
      this.protectTimer = null;
    }
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
    this.cancelTasksOfType("follow");
    this.cancelTasksOfType("attack");
    this.cancelTasksOfType("defend");
    this.setMode("idle", null);
    this.log().info("Takip/saldırı/koruma kapatıldı", reason);
    this.emitCombat();
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
      `ana takip=${this.companion.followPlayer ?? "—"} mob=${this.companion.protectSettings.retaliateMobs} oyuncu=${this.companion.protectSettings.retaliatePlayers} wl=${this.companion.protectSettings.whitelist.join(",") || "—"}`
    );
    this.emitCombat();
    return this.getRuntime();
  }

  private ensureFollowTask(player: string, distance: number, force = false) {
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

  /**
   * Tüm korunanların yanındaki tehditleri tara → DEFENSE.
   * Ana kişi (followPlayer) takipte kalır; ek korunanlar menzildeyse onlara da müdahale.
   */
  private protectTick() {
    if (!this.hasProtect() || this.instance.status !== "online") return;
    const bot = this.bot ?? this.instance.bot;
    if (!bot?.entity) return;

    // ana takip: followPlayer veya ilk korunan
    const main = this.companion.followPlayer ?? this.companion.protectPlayers[0]!;
    if (!this.companion.followPlayer) this.companion.followPlayer = main;
    this.ensureFollowTask(main, this.companion.followDistance);

    const settings = this.companion.protectSettings;
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
        // korunanların kendisine saldırma
        if (wardEntities.some((w) => w.ent === e)) continue;
        const d = wardEnt.position.distanceTo(e.position);
        if (d > settings.range) continue;

        const player = isPlayerEntity(e);
        const hostile = isHostileMob(String(e.name ?? e.displayName ?? ""));
        if (player) {
          if (!settings.retaliatePlayers) continue;
          const uname = e.username ?? "";
          if (uname && wl.has(uname.toLowerCase())) continue;
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
        label: `koru(${bestWard})→${label}`,
        priority: PRIORITY.DEFENSE,
        params: { target: label, ward: bestWard },
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

      await this.equipBestWeapon();

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
    await this.equipBestWeapon();

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
    const dropped = hp < this.lastHealth - 0.05;
    this.lastHealth = hp;

    if (!dropped) return;

    const mode = this.cfg().defendMode;
    // otomasyon her zaman (savunma kapalı olsa da) saldırgan adayını dener
    const attackerForRules = this.pickDefenseTarget(mode === "off" ? "all" : mode);
    if (attackerForRules) {
      const label0 = labelEntity(attackerForRules);
      const isPlayer = Boolean(attackerForRules.username) || attackerForRules.type === "player";
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
    const cur = this.instance.tasks.currentSummary;
    if (cur?.type === "defend" && cur.label.includes(label)) return;
    if (this.mode === "defending" && this.activeTargetLabel === label) return;

    this.log().info(`Savunma: ${label} (mod=${mode})`);
    this.instance.tasks.enqueue(
      {
        type: "defend",
        label: `savun: ${label}`,
        priority: PRIORITY.DEFENSE,
        params: { target: label },
        requeueOnPreempt: false
      },
      () => (token, report) => this.runDefend(attacker, label, token, report)
    );
  }

  private async runDefend(initial: Entity, label: string, token: TaskToken, report: ProgressFn) {
    await sleep(randomReactionMs(this.cfg()));
    if (token.cancelled) throw new Error(token.reason ?? "iptal");

    this.setMode("defending", label);
    await this.equipBestWeapon();

    const chase = this.cfg().chaseDistance ?? 24;
    const t0 = Date.now();

    while (!token.cancelled && Date.now() - t0 < 120_000) {
      if ((this.bot?.health ?? 20) <= (this.cfg().fleeAtHealth ?? 6)) {
        this.enqueueFlee(label);
        throw new Error("Can kritik");
      }

      let entity = this.findEntityByLabel(label) ?? (initial.isValid ? initial : null);
      // re-scan if gone
      if (!entity || !entity.isValid) {
        entity = this.pickDefenseTarget(this.cfg().defendMode);
        if (!entity) break;
      }

      const dist = distanceEyeToEntity(this.requireBot(), entity);
      report({ done: 0, total: 1, label: `savun ${labelEntity(entity)} · ${dist.toFixed(1)}m` });

      if (dist > chase) {
        this.log().info("Saldırgan menzilden çıktı — kovalama bırakıldı");
        break;
      }

      if (!inMeleeRange(this.requireBot(), entity, this.cfg().reach)) {
        await this.approachEntity(entity, 2, token);
        continue;
      }

      await tryRealisticAttack(this.requireBot(), entity, this.cfg(), this.lastSwing, token);
      await sleep(100);
    }

    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    this.restoreCompanionMode();
  }

  private onDeath() {
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
    this.setMode("idle", null);
    this.log().warn(
      "Bot öldü — ölüm konumu kaydedildi",
      `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} (${dimension}) · loot ~5 dk`
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

  private pickDefenseTarget(mode: CombatConfig["defendMode"]): Entity | null {
    const bot = this.bot;
    if (!bot) return null;
    const candidates: Entity[] = [];
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      const dist = bot.entity.position.distanceTo(e.position);
      if (dist > 8) continue;
      const player = isPlayerEntity(e);
      const hostile = isHostileMob(String(e.name ?? e.displayName ?? ""));
      if (mode === "player" && player) candidates.push(e);
      else if (mode === "mob" && hostile) candidates.push(e);
      else if (mode === "all" && (player || hostile)) candidates.push(e);
    }
    candidates.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
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
    const bot = this.bot;
    if (!bot) return null;
    // player name
    const p = bot.players[label]?.entity;
    if (p) return p;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e && labelEntity(e) === label) return e;
    }
    return null;
  }

  private async approachEntity(entity: Entity, range: number, token: TaskToken) {
    const bot = this.requireBot();
    try {
      ensureMovement(this.instance);
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);
      const t0 = Date.now();
      const { stepLookAtEntity } = await import("../movement/look");
      while (!token.cancelled && Date.now() - t0 < 15_000) {
        if (inMeleeRange(bot, entity, this.cfg().reach) && distanceEyeToEntity(bot, entity) <= range + 0.5) break;
        if (!entity.isValid) break;
        try {
          await stepLookAtEntity(bot, entity, this.cfg().turnSpeedDegPerTick ?? 24);
        } catch {
          /* */
        }
        await sleep(120);
      }
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        /* noop */
      }
    } catch (e) {
      this.log().debug("Yaklaşma başarısız", e instanceof Error ? e.message : String(e));
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

  async equipBestWeapon(): Promise<void> {
    const bot = this.bot;
    if (!bot) return;
    const banned = this.instance.config.inventory.bannedItems;
    const items = bot.inventory.items();
    const names = items.map((i) => i.name);
    const best = pickBestWeaponName(names, banned);
    if (!best) return;
    if (bot.heldItem?.name === best) return;
    if (banned.includes(best)) {
      this.log().warn(`En iyi silah yasaklı listede, kullanılmayacak: ${best}`);
      return;
    }
    const item = items.find((i) => i.name === best);
    if (!item) return;
    try {
      await bot.equip(item, "hand");
      this.log().debug(`Silah seçildi: ${best}`);
    } catch (e) {
      this.log().debug("Silah kuşanılamadı", e instanceof Error ? e.message : String(e));
    }
  }

  private requireBot(): Bot {
    const bot = this.bot ?? this.instance.bot;
    if (!bot || this.instance.status !== "online") throw new Error("Bot çevrimdışı — dövüş yapılamaz");
    this.bot = bot;
    return bot;
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

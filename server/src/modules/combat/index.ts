import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { BotInstance } from "../../core/BotInstance";
import { PRIORITY, type ProgressFn, type TaskToken } from "../../core/TaskQueue";
import type { CombatConfig, CombatRuntime, DeathRecord } from "../../types";
import { goals } from "mineflayer-pathfinder";
import { ensureMovement, runGoto } from "../movement";
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

/**
 * Per-bot combat brain (Faz 6). All hits go through RealismLayer.
 * Defense hooks attach on spawn; tasks run via TaskQueue (DEFENSE/SURVIVAL/USER).
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

  constructor(private readonly instance: BotInstance) {}

  getRuntime(): CombatRuntime {
    return {
      defendMode: this.instance.config.combat.defendMode,
      fighting: this.mode !== "idle",
      mode: this.mode,
      activeTarget: this.activeTargetLabel,
      lastDeath: this.lastDeath
    };
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
    this.detach();
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

    this.emitCombat();
  }

  detach() {
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
    this.setMode("idle", null);
  }

  stopCombat(reason = "dövüş durduruldu") {
    // cancel combat-priority tasks by cancelling all is heavy — cancel via stopMovement path is caller's choice
    this.setMode("idle", null);
    this.log().info("Dövüş bırakıldı", reason);
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
        report({ done: 0, total: 1, label: inTab ? `${playerName} menzil dışında — aranıyor` : `${playerName} görünmüyor` });
        if (!inTab) {
          this.log().info(`Saldırı hedefi bulunamadı: ${playerName} (tab listesinde yok)`, "İ1 — sohbete yazılmadı");
          throw new Error(`${playerName} sunucuda görünmüyor`);
        }
        // walk toward last known? without entity we cannot path to them
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
      } else if (res.reason === "los") {
        // strafe slightly / re-approach for better angle
        await this.approachEntity(entity, 2, token);
      } else if (res.reason === "range") {
        await this.approachEntity(entity, 2, token);
      } else if (res.reason === "cancelled") {
        throw new Error(res.detail ?? token.reason ?? "iptal");
      }

      // target dead?
      if (!bot.players[playerName]?.entity || (entity as { isValid?: boolean }).isValid === false) {
        // entity may still be in map until removed
      }
      if (entity.health !== undefined && entity.health <= 0) break;

      await sleep(50);
    }

    this.setMode("idle", null);
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
    report({ done: 1, total: 1, label: `saldırı bitti: ${playerName}` });
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
    if (mode === "off") {
      if (hp <= (this.cfg().fleeAtHealth ?? 6) && this.mode !== "fleeing") {
        // still flee on critical even if defend off? TODO says flee during combat — only if fighting
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

    // find attacker candidate
    const attacker = this.pickDefenseTarget(mode);
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

    this.setMode("idle", null);
    if (token.cancelled) throw new Error(token.reason ?? "iptal");
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
      while (!token.cancelled && Date.now() - t0 < 15_000) {
        if (inMeleeRange(bot, entity, this.cfg().reach) && distanceEyeToEntity(bot, entity) <= range + 0.5) break;
        if (!entity.isValid) break;
        await sleep(200);
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

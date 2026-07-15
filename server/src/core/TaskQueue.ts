import { EventEmitter } from "events";
import type { TaskSummary } from "../types";
import { newId } from "../types";

/**
 * Öncelikli görev kuyruğu (İ6): hayatta kalma > savunma > kullanıcı > otomasyon > boşta.
 * v1 kesme modeli: daha yüksek öncelikli görev gelirse çalışan görev iptal edilir ve
 * paramlarıyla kuyruğun önüne yeniden eklenir (yeniden başlatılabilir görevler için
 * "kaldığı yerden devam" etkisi — hedef mevcut konumdan yeniden hesaplanır).
 * Bağlam koruyan gerçek pause/resume: Faz 10.
 */

export const PRIORITY = {
  SURVIVAL: 100,
  DEFENSE: 80,
  USER: 50,
  AUTO: 30,
  IDLE: 10
} as const;

export interface TaskToken {
  cancelled: boolean;
  reason?: string;
}

export type ProgressFn = (p: { done: number; total: number; label?: string }) => void;
export type TaskRunner = (token: TaskToken, report: ProgressFn) => Promise<void>;

export interface TaskDef {
  type: string;
  label: string;
  priority: number;
  params: Record<string, unknown>;
  /** kesildiğinde yeniden kuyruğa eklensin mi (varsayılan true) */
  requeueOnPreempt?: boolean;
}

interface InternalTask {
  id: string;
  seq: number;
  def: TaskDef;
  state: TaskSummary["state"];
  token: TaskToken;
  progress?: { done: number; total: number; label?: string };
  error?: string;
  makeRunner: () => TaskRunner;
}

export class TaskQueue extends EventEmitter {
  private queue: InternalTask[] = [];
  private current: InternalTask | null = null;
  private pumping = false;
  private seq = 0;
  private history: TaskSummary[] = [];

  /** runner'ı üreten fabrika alınır — görev ÇALIŞMA anında taze bot referansı kurabilsin */
  enqueue(def: TaskDef, makeRunner: () => TaskRunner): TaskSummary {
    const task: InternalTask = {
      id: newId(),
      seq: this.seq++,
      def,
      state: "queued",
      token: { cancelled: false },
      makeRunner
    };
    this.queue.push(task);
    this.sortQueue();

    // kesme: çalışan görevden yüksek öncelik geldiyse çalışanı kes (+ yeniden kuyrukla)
    const cur = this.current;
    if (cur && def.priority > cur.def.priority) {
      this.preempt(cur, `yüksek öncelikli görev geldi: ${def.label}`);
    }

    this.emitUpdate();
    void this.pump();
    return this.summarize(task);
  }

  cancel(id: string, reason = "iptal edildi"): boolean {
    const cur = this.current;
    if (cur && cur.id === id) {
      cur.token.cancelled = true;
      cur.token.reason = reason;
      return true;
    }
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx >= 0) {
      const [t] = this.queue.splice(idx, 1);
      t!.state = "cancelled";
      this.pushHistory(t!);
      this.emitUpdate();
      return true;
    }
    return false;
  }

  cancelAll(reason = "tümü iptal edildi") {
    for (const t of this.queue) {
      t.state = "cancelled";
      this.pushHistory(t);
    }
    this.queue = [];
    const cur = this.current;
    if (cur) {
      cur.token.cancelled = true;
      cur.token.reason = reason;
    }
    this.emitUpdate();
  }

  /** Faz 10: çalışan görevi pause et — token cancel + requeue with same def (context = params) */
  pause(reason = "duraklatıldı"): boolean {
    const cur = this.current;
    if (!cur) return false;
    cur.token.cancelled = true;
    cur.token.reason = reason;
    cur.state = "paused";
    if (cur.def.requeueOnPreempt !== false) {
      const clone: InternalTask = {
        id: newId(),
        seq: this.seq++,
        def: { ...cur.def, params: { ...cur.def.params, _pausedFrom: cur.id } },
        state: "queued",
        token: { cancelled: false },
        makeRunner: cur.makeRunner
      };
      // paused tasks go front after sort by keeping high seq? put at front of same priority via lower seq
      clone.seq = -1;
      this.queue.unshift(clone);
    }
    this.emitUpdate();
    return true;
  }

  /** resume: no-op if already queued via pause requeue; pump continues */
  resume(): boolean {
    // paused clones already in queue — ensure pump
    void this.pump();
    this.emitUpdate();
    return this.queue.length > 0 || this.current != null;
  }

  get currentSummary(): TaskSummary | null {
    return this.current ? this.summarize(this.current) : null;
  }

  get queueSummaries(): TaskSummary[] {
    return this.queue.map((t) => this.summarize(t));
  }

  get historySummaries(): TaskSummary[] {
    return [...this.history];
  }

  private preempt(cur: InternalTask, reason: string) {
    cur.token.cancelled = true;
    cur.token.reason = reason;
    if (cur.def.requeueOnPreempt !== false) {
      // aynı def yeni görev olarak kuyruğa geri girer (öncelik sırasına göre yerleşir)
      const clone: InternalTask = {
        id: newId(),
        seq: this.seq++,
        def: cur.def,
        state: "queued",
        token: { cancelled: false },
        makeRunner: cur.makeRunner
      };
      this.queue.push(clone);
      this.sortQueue();
    }
  }

  private sortQueue() {
    this.queue.sort((a, b) => b.def.priority - a.def.priority || a.seq - b.seq);
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        this.sortQueue();
        const task = this.queue.shift()!;
        this.current = task;
        task.state = "running";
        this.emitUpdate();
        try {
          const runner = task.makeRunner();
          await runner(task.token, (p) => {
            task.progress = p;
            this.emitUpdate();
          });
          task.state = task.token.cancelled ? "cancelled" : "done";
        } catch (err) {
          task.state = task.token.cancelled ? "cancelled" : "failed";
          task.error = err instanceof Error ? err.message : String(err);
        }
        this.pushHistory(task);
        this.current = null;
        this.emitUpdate();
      }
    } finally {
      this.pumping = false;
    }
  }

  private pushHistory(task: InternalTask) {
    this.history.push(this.summarize(task));
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
    if (task.state === "failed") this.emit("taskFailed", this.summarize(task), task.error);
    if (task.state === "done") this.emit("taskDone", this.summarize(task));
  }

  private summarize(t: InternalTask): TaskSummary {
    return {
      id: t.id,
      type: t.def.type,
      label: t.def.label,
      state: t.state,
      progress: t.progress,
      error: t.error
    };
  }

  private emitUpdate() {
    this.emit("update");
  }
}

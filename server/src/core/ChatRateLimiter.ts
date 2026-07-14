/**
 * Global outgoing-chat throttle (İ5): every bot.chat() in the whole codebase
 * must go through an instance of this class. Direct bot.chat calls are banned
 * by convention (see TODO.md §12).
 */
export class ChatRateLimiter {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastSentAt = 0;

  constructor(
    private readonly sendFn: (text: string) => void,
    private readonly getIntervalMs: () => number,
    private readonly onQueueChange: (length: number) => void = () => {}
  ) {}

  get length(): number {
    return this.queue.length;
  }

  enqueue(text: string) {
    const clean = text.replace(/[\r\n]+/g, " ").trim();
    if (!clean) return;
    this.queue.push(clean);
    this.onQueueChange(this.queue.length);
    this.pump();
  }

  clear() {
    this.queue = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onQueueChange(0);
  }

  private pump() {
    if (this.timer || this.queue.length === 0) return;
    const wait = Math.max(0, this.lastSentAt + this.getIntervalMs() - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const text = this.queue.shift();
      if (text !== undefined) {
        this.lastSentAt = Date.now();
        try {
          this.sendFn(text);
        } catch {
          /* connection may have dropped between enqueue and send */
        }
        this.onQueueChange(this.queue.length);
      }
      if (this.queue.length > 0) this.pump();
    }, wait);
  }
}

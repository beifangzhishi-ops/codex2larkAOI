// 执行等待与结果交付独立；后端的迟到结果不能因本地计时结束而丢失。
export function turnDeliveryKey(threadId, turnId) {
  return JSON.stringify([threadId, turnId]);
}

export function terminalTurn(turn) {
  const status = typeof turn?.status === "string" ? turn.status : turn?.status?.type;
  return ["completed", "failed", "interrupted", "cancelled", "canceled"].includes(status);
}

export class ExecutionBudget {
  constructor(duration, onTimeout, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { remaining: duration, onTimeout, now, setTimer, clearTimer });
    this.waiting = new Set();
    this.disposed = false;
    this.resume();
  }
  pause(key) {
    if (this.disposed) return;
    this.waiting.add(key);
    if (this.timer != null) {
      this.remaining = Math.max(0, this.remaining - (this.now() - this.started));
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
  resume(key) {
    if (key !== undefined) this.waiting.delete(key);
    if (this.disposed || this.waiting.size || this.timer != null) return;
    this.started = this.now();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.disposed = true;
      this.onTimeout();
    }, this.remaining);
    this.timer?.unref?.();
  }
  dispose() {
    this.disposed = true;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }
}

export class TurnDelivery {
  constructor(records, { save, deliver, readThread, isBound, onSnapshot, log = console, intervalMs = 30_000 }) {
    Object.assign(this, { records, save, deliver, readThread, isBound, onSnapshot, log, intervalMs });
    this.queues = new Map();
    this.checking = new Set();
  }
  register(context) {
    const key = turnDeliveryKey(context.threadId, context.turnId);
    if (!this.records[key]) {
      this.records[key] = { ...context, terminal: false, status: "inProgress", items: {} };
      this.save();
    }
    return this.records[key];
  }
  find(threadId, turnId) { return this.records[turnDeliveryKey(threadId, turnId)]; }
  enqueue(record, item, kind = item.type === "plan" ? "plan" : "final") {
    const key = JSON.stringify([kind, item.id]);
    if (!record.items[key]) {
      record.items[key] = { item, kind, delivered: false };
      this.save();
      this.log.info(`[delivery] received thread=${record.threadId} turn=${record.turnId} item=${item.id} kind=${kind}`);
    }
    return this.flush(record);
  }
  flush(record) {
    const key = turnDeliveryKey(record.threadId, record.turnId);
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (!this.isBound(record)) return;
      for (const entry of Object.values(record.items)) {
        if (entry.delivered || !this.isBound(record)) continue;
        try {
          await this.deliver(record, entry);
          entry.delivered = true;
          this.save();
          this.log.info(`[delivery] sent thread=${record.threadId} turn=${record.turnId} item=${entry.item.id}`);
        } catch (error) {
          this.log.error(`[delivery] failed thread=${record.threadId} turn=${record.turnId} item=${entry.item.id}: ${error.message}`);
          break;
        }
      }
    });
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
    return next;
  }
  complete(record, turn) {
    record.terminal = terminalTurn(turn);
    record.status = turn.status;
    this.save();
  }
  async reconcile(record) {
    const key = turnDeliveryKey(record.threadId, record.turnId);
    if (this.checking.has(key) || !this.isBound(record)) return null;
    this.checking.add(key);
    try {
      const result = await this.readThread(record.threadId);
      const turn = result?.thread?.turns?.find((candidate) => candidate.id === record.turnId);
      if (turn) {
        await this.onSnapshot(record, turn);
        if (terminalTurn(turn)) this.complete(record, turn);
      }
      await this.flush(record);
      return turn || null;
    } finally { this.checking.delete(key); }
  }
  async recover() {
    for (const record of Object.values(this.records)) {
      if (!this.isBound(record)) continue;
      try {
        // 正常运行的轮次由事件驱动；只有恢复/超时轮次需要主动核对。
        if (!record.terminal && (record.recovering || record.timedOut)) await this.reconcile(record);
        else await this.flush(record);
      } catch (error) {
        this.log.warn(`[delivery] reconcile failed thread=${record.threadId} turn=${record.turnId}: ${error.message}`);
      }
    }
  }
  async start() {
    for (const record of Object.values(this.records)) if (!record.terminal) record.recovering = true;
    await this.recover();
    this.timer = setInterval(() => { void this.recover(); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }
}

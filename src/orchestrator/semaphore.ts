/**
 * A counting semaphore with a FIFO wait queue. Each holder and waiter
 * carries a key (a task id) so the dashboard can show who is using an
 * engine and who is queued, in order — and the CEO can move a waiter to the
 * front.
 */
export class Semaphore {
  private readonly holders: string[] = [];
  private readonly waiters: { key: string; grant: () => void }[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
  }

  get running(): number {
    return this.holders.length;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Keys currently holding a slot. */
  runningKeys(): string[] {
    return [...this.holders];
  }

  /** Keys waiting for a slot, next-served first. */
  waitingKeys(): string[] {
    return this.waiters.map((w) => w.key);
  }

  acquire(key = "?"): Promise<() => void> {
    if (this.holders.length < this.limit) {
      this.holders.push(key);
      return Promise.resolve(this.releaser(key));
    }
    return new Promise((resolve) => {
      this.waiters.push({
        key,
        grant: () => {
          this.holders.push(key);
          resolve(this.releaser(key));
        },
      });
    });
  }

  /** Moves the first waiter with this key to the front of the queue. False if it isn't waiting. */
  promote(key: string): boolean {
    const i = this.waiters.findIndex((w) => w.key === key);
    if (i === -1) return false;
    const [w] = this.waiters.splice(i, 1);
    this.waiters.unshift(w);
    return true;
  }

  async run<T>(fn: () => Promise<T>, key?: string): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const i = this.holders.indexOf(key);
      if (i !== -1) this.holders.splice(i, 1);
      this.waiters.shift()?.grant();
    };
  }
}

/** A counting semaphore with a FIFO wait queue, so waiters are served in arrival order. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve(this.releaser());
      });
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/orchestrator/semaphore.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Semaphore", () => {
  it("never lets more than `limit` holders run at once, and serves waiters in FIFO order", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (n: number) =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(n);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });

    await Promise.all([1, 2, 3, 4, 5].map(job));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports running and waiting counts, and ignores a double release", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const second = sem.acquire();
    await tick();
    expect(sem.running).toBe(1);
    expect(sem.waiting).toBe(1);

    release();
    release(); // no-op
    const release2 = await second;
    expect(sem.running).toBe(1);
    expect(sem.waiting).toBe(0);
    release2();
    expect(sem.running).toBe(0);
  });

  it("rejects a non-positive limit", () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});

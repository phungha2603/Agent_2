import { describe, expect, it } from "vitest";
import { createMusePoolAgent } from "../src/agents/muse.js";
import type { Agent, AgentResponse, TaskContext } from "../src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeAccount(name: string, delayMs: number, log: string[]): Agent {
  return {
    role: "muse",
    async send(prompt: string): Promise<AgentResponse> {
      log.push(`${name}:start:${prompt}`);
      await sleep(delayMs);
      log.push(`${name}:end:${prompt}`);
      return { role: "muse", content: `${name} replied to ${prompt}` };
    },
  };
}

describe("createMusePoolAgent", () => {
  it("runs chats on different accounts in parallel instead of serializing them", async () => {
    const log: string[] = [];
    const pool = createMusePoolAgent([fakeAccount("acc1", 40, log), fakeAccount("acc2", 40, log)]);

    const [r1, r2] = await Promise.all([
      pool.send("task A", {} as TaskContext),
      pool.send("task B", {} as TaskContext),
    ]);

    expect(new Set([r1.content, r2.content])).toEqual(new Set(["acc1 replied to task A", "acc2 replied to task B"]));
    // Both started before either finished — proof they ran concurrently, not one after the other.
    const firstEnd = log.findIndex((l) => l.includes(":end:"));
    expect(log.slice(0, firstEnd).filter((l) => l.includes(":start:"))).toHaveLength(2);
  });

  it("queues a third chat behind two busy accounts, then hands it to whichever frees up first", async () => {
    const log: string[] = [];
    // acc1 is much faster, so it's the one guaranteed to free up and pick up "C".
    const pool = createMusePoolAgent([fakeAccount("acc1", 15, log), fakeAccount("acc2", 60, log)]);

    const [a, b, c] = await Promise.all([
      pool.send("A", {} as TaskContext),
      pool.send("B", {} as TaskContext),
      pool.send("C", {} as TaskContext),
    ]);

    expect(a.content).toBe("acc1 replied to A");
    expect(b.content).toBe("acc2 replied to B");
    expect(c.content).toBe("acc1 replied to C"); // reused acc1 once it freed up, not left waiting on acc2
    expect(log.indexOf("acc1:start:C")).toBeGreaterThan(log.indexOf("acc1:end:A"));
  });

  it("closes every account in the pool", async () => {
    const closed: string[] = [];
    const account = (name: string): Agent => ({
      role: "muse",
      async send(): Promise<AgentResponse> {
        return { role: "muse", content: "" };
      },
      async close() {
        closed.push(name);
      },
    });
    const pool = createMusePoolAgent([account("acc1"), account("acc2")]);
    await pool.close?.();
    expect(closed.sort()).toEqual(["acc1", "acc2"]);
  });

  it("rejects an empty pool", () => {
    expect(() => createMusePoolAgent([])).toThrow();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMuseAgent, createMusePoolAgent } from "../src/agents/muse.js";
import type { Agent, AgentResponse, TaskContext } from "../src/types.js";

const connectMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({ connect: connectMock, callTool: callToolMock, close: closeMock })),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

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

  it("passes over an account that just failed while another one is free", async () => {
    const used: string[] = [];
    let failFirst = true;
    const account = (name: string): Agent => ({
      role: "muse",
      async send(): Promise<AgentResponse> {
        used.push(name);
        if (name === "acc1" && failFirst) {
          failFirst = false;
          throw new Error("Muse did not start replying within 240s");
        }
        return { role: "muse", content: "ok" };
      },
    });
    let t = 0;
    const pool = createMusePoolAgent([account("acc1"), account("acc2")], { cooldownMs: 1000, now: () => t });
    await expect(pool.send("a", {} as TaskContext)).rejects.toThrow(/did not start/);
    await pool.send("b", {} as TaskContext); // retry goes to acc2, not the stuck acc1
    t = 5000; // cooldown over
    await pool.send("c", {} as TaskContext);
    expect(used).toEqual(["acc1", "acc2", "acc1"]);
  });

  it("rejects an empty pool", () => {
    expect(() => createMusePoolAgent([])).toThrow();
  });
});

describe("createMuseAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(undefined);
  });

  it("starts each account's server with its own profile and without the HTTP shim, so pooled servers don't fight over port 8787", async () => {
    callToolMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    await createMuseAgent({ serverPath: "/fake/server.mjs", profileDir: "/p2" }).send("hi", { title: "t" } as TaskContext);
    const env = (vi.mocked(StdioClientTransport).mock.calls[0][0] as any).env;
    expect(env).toMatchObject({ MUSE_SHIM_PORT: "0", MUSE_PROFILE_DIR: "/p2" });
  });

  it("reconnects with a fresh client after the connection dies mid-session, instead of reusing the dead one forever", async () => {
    callToolMock
      .mockRejectedValueOnce(new Error("MCP error -32000: Connection closed"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok reply" }] });

    const agent = createMuseAgent({ serverPath: "/fake/server.mjs" });

    await expect(agent.send("hi", { title: "t" } as TaskContext)).rejects.toThrow("Connection closed");
    expect(Client).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1); // the dead client was closed, not just abandoned

    // A retry (a brand new send() call, exactly what the CEO's "Thử lại" button does) must not hit the same dead connection again.
    const res = await agent.send("hi again", { title: "t" } as TaskContext);
    expect(res.content).toBe("ok reply");
    expect(Client).toHaveBeenCalledTimes(2); // reconnected instead of reusing the broken client
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("waits for the dead client to actually finish closing before spawning the next one — a reconnect racing an in-progress Chrome shutdown would fight over the same profile dir", async () => {
    let resolveClose!: () => void;
    closeMock.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveClose = resolve)));
    callToolMock
      .mockRejectedValueOnce(new Error("MCP error -32000: Connection closed"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok reply" }] });

    const agent = createMuseAgent({ serverPath: "/fake/server.mjs" });
    await expect(agent.send("hi", { title: "t" } as TaskContext)).rejects.toThrow("Connection closed");
    expect(Client).toHaveBeenCalledTimes(1);

    // The retry is already in flight, but close() on the dead client hasn't resolved yet.
    let settled = false;
    const retry = agent.send("hi again", { title: "t" } as TaskContext).then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(Client).toHaveBeenCalledTimes(1); // must not have spawned a second client yet

    resolveClose();
    const res = await retry;
    expect(res.content).toBe("ok reply");
    expect(Client).toHaveBeenCalledTimes(2); // only spawned once the old one was fully gone
  });

  it("keeps reusing the same client across calls when nothing ever fails", async () => {
    callToolMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const agent = createMuseAgent({ serverPath: "/fake/server.mjs" });

    await agent.send("one", { title: "t" } as TaskContext);
    await agent.send("two", { title: "t" } as TaskContext);

    expect(Client).toHaveBeenCalledTimes(1); // no reason to reconnect when nothing broke
  });
});

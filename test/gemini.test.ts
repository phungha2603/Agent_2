import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiAgent, parseGoogleRetryDelayMs } from "../src/agents/gemini.js";
import type { TaskContext } from "../src/types.js";

describe("parseGoogleRetryDelayMs", () => {
  it("extracts the seconds from a RetryInfo detail and converts to ms", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        details: [
          { "@type": "type.googleapis.com/google.rpc.Help" },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "45.433900686s" },
        ],
      },
    });
    expect(parseGoogleRetryDelayMs(body)).toBe(45434);
  });

  it("returns undefined when there is no RetryInfo detail", () => {
    const body = JSON.stringify({ error: { code: 400, details: [] } });
    expect(parseGoogleRetryDelayMs(body)).toBeUndefined();
  });

  it("returns undefined for malformed JSON instead of throwing", () => {
    expect(parseGoogleRetryDelayMs("not json")).toBeUndefined();
  });
});

describe("createGeminiAgent key dispatch", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("round-robins across keys on successive calls instead of sticking to whichever one last succeeded", async () => {
    const seenKeys: string[] = [];
    global.fetch = vi.fn(async (_url: unknown, init: any) => {
      seenKeys.push(init.headers["x-goog-api-key"]);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) } as any;
    }) as unknown as typeof fetch;

    const agent = createGeminiAgent({ apiKeys: ["k1", "k2", "k3"] });
    for (let i = 0; i < 4; i++) await agent.send("hello", {} as TaskContext);

    // Every call lands on a different key than the one before it, cycling through the whole pool.
    expect(seenKeys[0]).not.toBe(seenKeys[1]);
    expect(seenKeys[1]).not.toBe(seenKeys[2]);
    expect(new Set(seenKeys.slice(0, 3))).toEqual(new Set(["k1", "k2", "k3"])); // first 3 calls cover the whole pool
    expect(seenKeys[3]).toBe(seenKeys[0]); // 4th call wraps back to where the 1st landed
  });

  it("still fails over through the rest of the pool within one call when the dispatched key is rate-limited", async () => {
    const seenKeys: string[] = [];
    global.fetch = vi.fn(async (_url: unknown, init: any) => {
      const key = init.headers["x-goog-api-key"];
      seenKeys.push(key);
      if (key !== "k3") return { ok: false, status: 429, text: async () => "{}" } as any;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) } as any;
    }) as unknown as typeof fetch;

    const agent = createGeminiAgent({ apiKeys: ["k1", "k2", "k3"] });
    const res = await agent.send("hello", {} as TaskContext);

    expect(res.content).toBe("ok");
    expect(seenKeys).toEqual(["k2", "k3"]); // dispatched to k2 first (round-robin), 429'd, failed over to k3
  });
});

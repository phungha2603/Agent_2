import { describe, expect, it, vi } from "vitest";
import { HttpStatusError, createKeyPool, isTransientApiError, withKeyRotation, withRetry } from "../src/agents/retry.js";

describe("withRetry", () => {
  it("retries transient errors and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new HttpStatusError(503, "overloaded");
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new HttpStatusError(401, "unauthorized");
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow("unauthorized");
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new HttpStatusError(429, "rate limited");
        },
        { retries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("rate limited");
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  it("waits at least as long as a server-hinted retryAfterMs, not just the exponential backoff", async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const result = await withRetry(
      async () => {
        timestamps.push(Date.now());
        calls += 1;
        if (calls < 2) {
          throw new HttpStatusError(429, "rate limited", 50);
        }
        return "ok";
      },
      { baseDelayMs: 1 }, // exponential backoff alone would be ~1ms — far less than the 50ms hint
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(50);
  });

  it("retries a network-level fetch failure (connection timeout, not an HTTP response)", async () => {
    let calls = 0;
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: new AggregateError([Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })], "ETIMEDOUT"),
    });
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw fetchFailed;
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("withKeyRotation — invalid keys", () => {
  it("drops a key rejected with 401/403 and serves the call with the next one", async () => {
    const pool = createKeyPool(["bad", "good"]);
    const seen: string[] = [];
    const call = (key: string) => {
      seen.push(key);
      if (key === "bad") return Promise.reject(new HttpStatusError(401, "API key not valid"));
      return Promise.resolve(`ok:${key}`);
    };
    expect(await withKeyRotation(pool, call)).toBe("ok:good");
    expect(pool.size).toBe(1);
    expect(await withKeyRotation(pool, call)).toBe("ok:good"); // the bad key never comes back
    expect(seen).toEqual(["bad", "good", "good"]);
  });

  it("still fails when the last remaining key is invalid", async () => {
    const pool = createKeyPool(["only"]);
    await expect(withKeyRotation(pool, () => Promise.reject(new HttpStatusError(403, "forbidden")))).rejects.toThrow("forbidden");
  });
});

describe("withKeyRotation", () => {
  it("rotates to the next key on 429 and succeeds without touching withRetry's backoff", async () => {
    const pool = createKeyPool(["k1", "k2", "k3"]);
    const tried: string[] = [];
    const result = await withKeyRotation(pool, async (key) => {
      tried.push(key);
      if (key !== "k3") throw new HttpStatusError(429, "rate limited");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(tried).toEqual(["k1", "k2", "k3"]);
    expect(pool.current()).toBe("k3"); // sticks with the working key for the next call
  });

  it("does not rotate on an error that isn't about the key (e.g. a bad request)", async () => {
    const pool = createKeyPool(["k1", "k2"]);
    let calls = 0;
    await expect(
      withKeyRotation(pool, async () => {
        calls += 1;
        throw new HttpStatusError(400, "bad request");
      }),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
    expect(pool.current()).toBe("k1");
  });

  it("rethrows once every key in the pool has 429'd", async () => {
    const pool = createKeyPool(["k1", "k2"]);
    let calls = 0;
    await expect(
      withKeyRotation(pool, async () => {
        calls += 1;
        throw new HttpStatusError(429, "rate limited");
      }),
    ).rejects.toThrow("rate limited");
    expect(calls).toBe(2);
  });

  it("combines with withRetry: exhausts the pool, backs off, then retries the whole cycle", async () => {
    const pool = createKeyPool(["k1", "k2"]);
    let calls = 0;
    const result = await withRetry(
      () =>
        withKeyRotation(pool, async (key) => {
          calls += 1;
          // Both keys fail once; the second cycle (after backoff) succeeds on k1.
          if (calls <= 2) throw new HttpStatusError(429, "rate limited");
          return key;
        }),
      { baseDelayMs: 1 },
    );
    expect(result).toBe("k1");
    expect(calls).toBe(3);
  });
});

describe("isTransientApiError", () => {
  it("recognizes a Node fetch TypeError wrapping ETIMEDOUT", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ETIMEDOUT" },
    });
    expect(isTransientApiError(err)).toBe(true);
  });

  it("does not treat an unrelated error as transient", () => {
    expect(isTransientApiError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientApiError(new HttpStatusError(401, "unauthorized"))).toBe(false);
  });
});

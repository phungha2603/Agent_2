import { describe, expect, it, vi } from "vitest";
import { HttpStatusError, isTransientApiError, withRetry } from "../src/agents/retry.js";

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

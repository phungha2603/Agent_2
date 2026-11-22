import { describe, expect, it } from "vitest";
import { parseGoogleRetryDelayMs } from "../src/agents/gemini.js";

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

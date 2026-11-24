import { describe, expect, it } from "vitest";
import { compressForClaude } from "../src/orchestrator/compressForClaude.js";
import type { Agent, AgentResponse, TaskContext } from "../src/types.js";

function stubGemini(reply: (prompt: string) => AgentResponse | Promise<AgentResponse>): Agent {
  return {
    role: "gemini",
    async send(prompt: string): Promise<AgentResponse> {
      return reply(prompt);
    },
  };
}

describe("compressForClaude", () => {
  it("skips the Gemini call entirely when nothing is big enough to be worth compressing", async () => {
    const neverCalled = stubGemini(() => {
      throw new Error("should not have been called");
    });
    const ctx: TaskContext = { title: "T", verificationLog: "short log", implementationDiff: "short diff", reviewFeedback: ["short feedback"] };

    const out = await compressForClaude(neverCalled, ctx);
    expect(out).toEqual(ctx);
  });

  it("replaces a large field with Gemini's summary of it, leaving small fields untouched", async () => {
    const bigLog = "L".repeat(5000) + "\nACTUAL FAILURE HERE";
    const gemini = stubGemini((prompt) => {
      expect(prompt).toContain("=== verificationLog ===");
      return { role: "gemini", content: "=== verificationLog ===\nShort brief: failed because X, see ACTUAL FAILURE HERE." };
    });
    const ctx: TaskContext = { title: "T", verificationLog: bigLog, implementationDiff: "small diff", acceptanceCriteria: ["a", "b"] };

    const out = await compressForClaude(gemini, ctx);
    expect(out.verificationLog).toBe("Short brief: failed because X, see ACTUAL FAILURE HERE.");
    expect(out.implementationDiff).toBe("small diff"); // untouched — wasn't big enough to send for compression
    expect(out.acceptanceCriteria).toEqual(["a", "b"]);
    expect(out.title).toBe("T");
  });

  it("never sends architectureSpec to Gemini and never touches it, however large", async () => {
    const bigSpec = "S".repeat(50_000);
    const gemini = stubGemini((prompt) => {
      expect(prompt).not.toContain("S".repeat(100)); // the spec text itself never appears in the compression prompt
      return { role: "gemini", content: "=== reviewFeedback ===\nbrief feedback" };
    });
    const ctx: TaskContext = { title: "T", architectureSpec: bigSpec, reviewFeedback: ["R".repeat(5000)] };

    const out = await compressForClaude(gemini, ctx);
    expect(out.architectureSpec).toBe(bigSpec); // byte-identical — a diff round depends on this
    expect(out.reviewFeedback).toEqual(["brief feedback"]);
  });

  it("falls back to the original, uncompressed context when Gemini errors", async () => {
    const failing = stubGemini(() => {
      throw new Error("Gemini API error 503");
    });
    const ctx: TaskContext = { title: "T", verificationLog: "V".repeat(5000) };

    const out = await compressForClaude(failing, ctx);
    expect(out).toEqual(ctx);
  });

  it("keeps a field's original text when Gemini's reply omits that section", async () => {
    const gemini = stubGemini(() => ({
      role: "gemini",
      content: "=== verificationLog ===\nsummarized log only", // no "=== reviewFeedback ===" section in the reply
    }));
    const bigFeedback = "F".repeat(5000);
    const ctx: TaskContext = { title: "T", verificationLog: "V".repeat(5000), reviewFeedback: [bigFeedback] };

    const out = await compressForClaude(gemini, ctx);
    expect(out.verificationLog).toBe("summarized log only");
    expect(out.reviewFeedback).toEqual([bigFeedback]); // not silently dropped
  });
});

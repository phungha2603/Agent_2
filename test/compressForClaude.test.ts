import { describe, expect, it } from "vitest";
import { compressForClaude } from "../src/orchestrator/compressForClaude.js";
import { condenseVerificationLog, pruneContext } from "../src/orchestrator/contextPruning.js";
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
    const bigDiff = "L".repeat(5000) + "\nACTUAL CHANGE HERE";
    const gemini = stubGemini((prompt) => {
      expect(prompt).toContain("=== implementationDiff ===");
      return { role: "gemini", content: "=== implementationDiff ===\nShort brief: changed X, see ACTUAL CHANGE HERE." };
    });
    const ctx: TaskContext = { title: "T", implementationDiff: bigDiff, reviewFeedback: ["small feedback"], acceptanceCriteria: ["a", "b"] };

    const out = await compressForClaude(gemini, ctx);
    expect(out.implementationDiff).toBe("Short brief: changed X, see ACTUAL CHANGE HERE.");
    expect(out.reviewFeedback).toEqual(["small feedback"]); // untouched — wasn't big enough to send for compression
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
    const ctx: TaskContext = { title: "T", implementationDiff: "V".repeat(5000) };

    const out = await compressForClaude(failing, ctx);
    expect(out).toEqual(ctx);
  });

  it("keeps a field's original text when Gemini's reply omits that section", async () => {
    const gemini = stubGemini(() => ({
      role: "gemini",
      content: "=== implementationDiff ===\nsummarized diff only", // no "=== reviewFeedback ===" section in the reply
    }));
    const bigFeedback = "F".repeat(5000);
    const ctx: TaskContext = { title: "T", implementationDiff: "V".repeat(5000), reviewFeedback: [bigFeedback] };

    const out = await compressForClaude(gemini, ctx);
    expect(out.implementationDiff).toBe("summarized diff only");
    expect(out.reviewFeedback).toEqual([bigFeedback]); // not silently dropped
  });

  it("never sends the verification log to Gemini", async () => {
    const neverCalled = stubGemini(() => {
      throw new Error("should not have been called");
    });
    const ctx: TaskContext = { title: "T", verificationLog: "V".repeat(50_000) };
    expect(await compressForClaude(neverCalled, ctx)).toEqual(ctx);
  });

  it("a review sees the written file's test lines even when they sit far from the end of a long log", () => {
    const before = Array.from({ length: 60 }, (_, i) => `test_a${i} (test_other.T.test_a${i}) ... ok`);
    const after = Array.from({ length: 150 }, (_, i) => `test_b${i} (test_other.T.test_b${i}) ... ok`);
    const log = [
      "$ python3 -m unittest discover -s tests -v",
      ...before,
      "test_flip (test_e3_integration.T.test_flip) ... ok",
      ...after,
      "Ran 211 tests in 2.1s",
      "",
      "OK",
      "== Role checks (AG-08 QA Lead): OK ==",
    ].join("\n");
    expect(log.length).toBeGreaterThan(8000);
    const seen = pruneContext("review_claude", { title: "T", verificationLog: log, implementationFiles: ["tests/test_e3_integration.py"] }).verificationLog!;
    for (const line of ["$ python3 -m unittest discover -s tests -v", "test_flip (test_e3_integration.T.test_flip) ... ok", "Ran 211 tests in 2.1s", "OK", "== Role checks (AG-08 QA Lead): OK =="]) {
      expect(seen).toContain(line);
    }
    expect(seen).not.toContain("test_b42 ");
    expect(seen).toContain("(150 line(s) omitted)");
  });

  it("keeps a failing command's output tail in full", () => {
    const noise = Array.from({ length: 200 }, (_, i) => `noise line ${i} ${"x".repeat(20)}`);
    const tail = ["  File \"a.py\", line 3, in f", "    return g()", "FAILED: Command failed: python3 -m footpredict"];
    const out = condenseVerificationLog(["$ python3 -m footpredict", ...noise, ...tail].join("\n"), []);
    expect(out).toContain(tail.join("\n"));
    expect(out).toContain("noise line 199");
    expect(out).not.toContain("noise line 5 ");
  });
});

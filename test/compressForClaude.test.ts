import { describe, expect, it } from "vitest";
import { compressForClaude, condenseVerificationLog } from "../src/orchestrator/compressForClaude.js";
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

  it("never sends the verification log to Gemini; trims it by code, keeping the evidence verbatim", async () => {
    const passing = Array.from({ length: 150 }, (_, i) => `test_case_${i} (tests.test_other.T.test_case_${i}) ... ok`);
    const log = [
      "$ python3 -m unittest discover -s tests -v",
      ...passing,
      "test_flip (tests.test_e3_integration.T.test_flip) ... ok",
      "",
      "----------------------------------------------------------------------",
      "Ran 151 tests in 2.1s",
      "",
      "OK",
      "== Role checks (AG-08 QA Lead): OK ==",
    ].join("\n");
    const neverCalled = stubGemini(() => {
      throw new Error("should not have been called");
    });
    const ctx: TaskContext = { title: "T", verificationLog: log, implementationFiles: ["tests/test_e3_integration.py"] };

    const out = await compressForClaude(neverCalled, ctx);
    expect(out.verificationLog!.length).toBeLessThan(log.length / 5);
    for (const line of ["$ python3 -m unittest discover -s tests -v", "test_flip (tests.test_e3_integration.T.test_flip) ... ok", "Ran 151 tests in 2.1s", "OK", "== Role checks (AG-08 QA Lead): OK =="]) {
      expect(out.verificationLog).toContain(line);
    }
    expect(out.verificationLog).not.toContain("test_case_42 ");
    expect(out.verificationLog).toContain("(150 line(s) omitted)");
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

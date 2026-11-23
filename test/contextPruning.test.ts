import { describe, expect, it } from "vitest";
import { PRUNE_LIMITS, pruneContext } from "../src/orchestrator/contextPruning.js";
import { formatContext } from "../src/agents/context.js";
import type { TaskContext } from "../src/types.js";

function bigContext(): TaskContext {
  return {
    title: "Feature",
    sharedBrief: "Company goal: X",
    ideaBrief: "brief",
    acceptanceCriteria: ["returns 200", "has a test"],
    upstream: [{ taskId: "u1", slotId: "AG-03", title: "Pipeline", acceptanceCriteria: [], files: ["a.ts"], specExcerpt: "spec", at: "" }],
    architectureSpec: "S".repeat(10_000),
    implementationDiff: "D".repeat(120_000),
    implementationFiles: ["a.ts"],
    verificationLog: "L".repeat(50_000) + "THE ACTUAL FAILURE",
    reviewFeedback: [],
  };
}

describe("pruneContext", () => {
  it("gives the architect no code or build output on a first pass", () => {
    const out = pruneContext("architecture", bigContext());
    expect(out.implementationDiff).toBeUndefined();
    expect(out.verificationLog).toBeUndefined();
    expect(out.architectureSpec).toBeUndefined(); // only shown when revising
    expect(out.acceptanceCriteria).toEqual(["returns 200", "has a test"]);
    expect(out.upstream).toHaveLength(1);
  });

  it("shows the architect its previous spec only when revising", () => {
    const out = pruneContext("architecture", { ...bigContext(), reviewFeedback: ["fix X"] });
    expect(out.architectureSpec).toBeTruthy();
  });

  it("keeps the end of the verification log for reviewers, where the failure is", () => {
    const out = pruneContext("review_claude", bigContext());
    expect(out.verificationLog!.length).toBeLessThan(PRUNE_LIMITS.verificationLogTail + 100);
    expect(out.verificationLog).toContain("THE ACTUAL FAILURE");
    expect(out.implementationDiff!.length).toBeLessThan(PRUNE_LIMITS.implementationDiffHead + 100);
    expect(out.ideaBrief).toBeUndefined();
  });

  it("gives the engineer the spec, criteria and handoffs — and its previous attempt only on a fix round", () => {
    const first = pruneContext("implementation", bigContext());
    expect(first.architectureSpec).toBeTruthy();
    expect(first.implementationDiff).toBeUndefined();
    expect(first.verificationLog).toBeUndefined();
    expect(first.ideaBrief).toBeUndefined();

    const fix = pruneContext("implementation", { ...bigContext(), reviewFeedback: ["Claude: fix step 2"] });
    expect(fix.implementationDiff!.length).toBeLessThan(PRUNE_LIMITS.previousImplementationHead + 100);
  });

  it("cuts the rendered prompt substantially compared with sending everything", () => {
    const ctx = bigContext();
    const full = formatContext(ctx).length;
    for (const stage of ["architecture", "architecture_review", "implementation", "review_gemini", "review_claude"] as const) {
      expect(formatContext(pruneContext(stage, ctx)).length).toBeLessThan(full * 0.6);
    }
  });
});

import { describe, expect, it } from "vitest";
import { createPatch } from "diff";
import { applyArchitectureRevision } from "../src/orchestrator/archRevision.js";

describe("applyArchitectureRevision", () => {
  it("applies a well-formed unified diff and reports it as patched", () => {
    const current = "line 1\nline 2\nold line 3\nline 4\n";
    const updated = "line 1\nline 2\nnew line 3\nline 4\n";
    const patch = createPatch("spec", current, updated);

    const result = applyArchitectureRevision(current, patch);
    expect(result.patched).toBe(true);
    expect(result.spec).toBe(updated);
  });

  it("falls back to using the reply verbatim when it isn't a diff at all", () => {
    const current = "old full spec";
    const reply = "Here is the complete updated guide: new full spec text.";

    const result = applyArchitectureRevision(current, reply);
    expect(result.patched).toBe(false);
    expect(result.spec).toBe(reply);
  });

  it("falls back to using the reply verbatim when the diff looks right but doesn't match the current text", () => {
    const current = "completely different text that the diff below doesn't describe";
    const patch = createPatch("spec", "line 1\nline 2\nold line 3\n", "line 1\nline 2\nnew line 3\n");

    const result = applyArchitectureRevision(current, patch);
    expect(result.patched).toBe(false);
    expect(result.spec).toBe(patch); // the raw (unapplied) diff text becomes the new spec, not silently dropped
  });
});

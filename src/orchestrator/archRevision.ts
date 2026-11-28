import { applyPatch } from "diff";

export interface ArchitectureRevisionResult {
  spec: string;
  /** False means claudeReply wasn't a diff that actually applied, so it was used as the new spec verbatim instead. */
  patched: boolean;
}

/**
 * Applies a unified diff Claude wrote against `current` (the architecture
 * spec's exact previous text). Falls back to treating `claudeReply` as the
 * new spec verbatim whenever it isn't a diff that actually applies — a
 * model that ignores the diff instruction, or gets the diff wrong, still
 * produces a usable spec, just without that round's token savings. A small
 * fuzz factor tolerates the kind of near-miss context lines an LLM-written
 * diff commonly has, without weakening the "did it really apply" check.
 */
export function applyArchitectureRevision(current: string, claudeReply: string): ArchitectureRevisionResult {
  const trimmed = claudeReply.trim();
  const looksLikeDiff = /^(---|\*\*\*|Index:|diff )/.test(trimmed);
  if (!looksLikeDiff) return { spec: claudeReply, patched: false };

  try {
    const patched = applyPatch(current, trimmed, { fuzzFactor: 4 });
    if (typeof patched !== "string") return { spec: claudeReply, patched: false };
    return { spec: patched, patched: true };
  } catch {
    return { spec: claudeReply, patched: false };
  }
}

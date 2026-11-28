import type { HandoffArtifact, Stage, TaskRecord } from "../types.js";

const SPEC_EXCERPT_CHARS = 2500;

/** The stages at which a task's result counts as ready for its dependents. */
export type HandoffPoint = "checkpoint_final" | "done";

export function reachedHandoffPoint(stage: Stage, point: HandoffPoint): boolean {
  return point === "checkpoint_final" ? stage === "checkpoint_final" || stage === "done" : stage === "done";
}

/**
 * Computed once per upstream task and copied to every dependent — the
 * shared, cached summary of what was built, instead of each dependent
 * re-reading (or being sent) the upstream's whole history.
 */
export function buildHandoff(task: TaskRecord): HandoffArtifact {
  const spec = task.context.architectureSpec ?? "";
  return {
    taskId: task.id,
    slotId: task.slotId,
    title: task.context.title,
    acceptanceCriteria: task.context.acceptanceCriteria ?? [],
    files: task.context.implementationFiles ?? [],
    specExcerpt: spec.length <= SPEC_EXCERPT_CHARS ? spec : `${spec.slice(0, SPEC_EXCERPT_CHARS)}\n…[truncated]`,
    at: new Date().toISOString(),
  };
}

import type { TaskRecord } from "../types.js";
import type { RoleSupport } from "../orchestrator/pipeline.js";
import { runRoleChecks } from "../verify/roleChecks.js";
import { roleById } from "./roles.js";
import { formatGuidance, loadPlaybook } from "./playbooks.js";
import { acceptedLessons } from "./lessons.js";

export interface RoleModels {
  /** CLAUDE_MODEL_LIGHT: architecture calls of "light" roles. */
  light?: string;
  /** CLAUDE_MODEL_STRONG: architecture and review calls of "strong" roles. */
  strong?: string;
}

/**
 * What the pipeline needs to know about a task's role: the playbook text for
 * each step, the role's own verification checks, and which Claude model its
 * calls should use. A task without a known role (no slot, or a slot id that no
 * longer exists) gets none of this and runs exactly as before.
 */
export function createRoleSupport(models: RoleModels = {}): RoleSupport {
  return {
    async guidance(task: TaskRecord, stage) {
      const role = roleById(task.slotId);
      if (!role) return undefined;
      const [playbook, lessons] = await Promise.all([loadPlaybook(role.id), stage === "ideation" ? Promise.resolve([]) : acceptedLessons(role.id)]);
      return formatGuidance(role.id, playbook, stage, lessons);
    },
    async checks(task, input) {
      const role = roleById(task.slotId);
      return role?.checks.length ? runRoleChecks(role.checks, input) : [];
    },
    claudeModel(task, purpose) {
      const tier = roleById(task.slotId)?.modelTier;
      if (tier === "strong") return models.strong;
      if (tier === "light" && purpose === "architecture") return models.light;
      return undefined;
    },
    label(task) {
      const role = roleById(task.slotId);
      return role ? `${role.id} ${role.name.replace(/^AI /, "")}` : undefined;
    },
  };
}

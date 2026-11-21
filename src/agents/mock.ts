import type { Agent, AgentResponse, RoleName, TaskContext } from "../types.js";

/**
 * Deterministic stand-in agents, used so the orchestrator's state machine
 * (stages, gates, retry/reject loops) can be exercised and tested without
 * any API key or the Muse browser session.
 */
export function createMockAgent(role: RoleName): Agent {
  return {
    role,
    async send(prompt: string, context: TaskContext): Promise<AgentResponse> {
      switch (role) {
        case "gemini":
          if (prompt.startsWith("REVIEW:")) {
            return { role, verdict: "approve", content: "Gemini review: looks consistent with the brief." };
          }
          return {
            role,
            content: `Idea brief for "${context.title}": goals, target users, and a rough scope outline.`,
          };
        case "claude":
          if (prompt.startsWith("REVIEW:")) {
            return { role, verdict: "approve", content: "Claude sign-off: architecture followed, no blocking concerns." };
          }
          return {
            role,
            content: `Architecture spec for "${context.title}": modules, data flow, and interfaces Muse should implement (no code).`,
          };
        case "muse":
          return {
            role,
            content: `diff --git a/mock.patch\n+// implementation for: ${context.title}\n`,
          };
        default:
          return { role, content: "" };
      }
    },
  };
}

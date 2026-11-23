import type { Agent, AgentResponse, SendOptions, TaskContext } from "../types.js";
import type { Semaphore } from "../orchestrator/semaphore.js";

export type EngineName = "claude" | "gemini" | "muse" | "workspace";

export interface EngineActivityHooks {
  onWait?(taskId: string, engine: EngineName): void;
  onStart?(taskId: string, engine: EngineName): void;
  onEnd?(taskId: string, engine: EngineName): void;
}

/**
 * Caps how many calls to one engine run at once, whichever stage (or the
 * planner, or the Gemini-down fallback) makes them — the limit lives on the
 * engine, not on any particular stage.
 */
export function limitAgent(agent: Agent, sem: Semaphore, engine: EngineName, hooks: EngineActivityHooks = {}): Agent {
  return {
    role: agent.role,
    async send(prompt: string, context: TaskContext, opts?: SendOptions): Promise<AgentResponse> {
      const id = opts?.taskId ?? "unknown";
      hooks.onWait?.(id, engine);
      const release = await sem.acquire();
      hooks.onStart?.(id, engine);
      try {
        return await agent.send(prompt, context, opts);
      } finally {
        release();
        hooks.onEnd?.(id, engine);
      }
    },
    close: agent.close ? () => agent.close!() : undefined,
  };
}

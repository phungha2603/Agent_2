import type { Agent, AgentResponse, SendOptions, TaskContext, Usage } from "../types.js";
import type { Semaphore } from "../orchestrator/semaphore.js";
import { formatContext } from "./context.js";

export type EngineName = "claude" | "gemini" | "muse" | "workspace";

/** USD per million tokens, when configured — only used if the provider didn't report a cost itself. */
export interface Price {
  inPerM: number;
  outPerM: number;
}

/** Everything about one agent call: what the drawer shows and what telemetry adds up. */
export interface CallRecord {
  taskId: string;
  engine: EngineName;
  startedAt: string;
  endedAt: string;
  waitMs: number;
  /** Exactly what the agent received: the stage prompt plus its rendered context. */
  prompt: string;
  output: string;
  verdict?: string;
  usage: Usage;
  error?: string;
}

export interface EngineActivityHooks {
  onWait?(taskId: string, engine: EngineName): void;
  onStart?(taskId: string, engine: EngineName): void;
  onEnd?(taskId: string, engine: EngineName): void;
  onCall?(record: CallRecord): void;
}

/** ~4 characters per token — only for agents that report no usage (Muse, mocks). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function withCost(usage: Usage, price?: Price): Usage {
  if (usage.costUsd !== undefined || !price) return usage;
  return { ...usage, costUsd: (usage.inputTokens * price.inPerM + usage.outputTokens * price.outPerM) / 1_000_000 };
}

/**
 * Caps how many calls to one engine run at once, whichever stage (or the
 * planner, or the Gemini-down fallback) makes them — the limit lives on the
 * engine, not on any particular stage. Also records every call.
 */
export function limitAgent(agent: Agent, sem: Semaphore, engine: EngineName, hooks: EngineActivityHooks = {}, price?: Price): Agent {
  return {
    role: agent.role,
    async send(prompt: string, context: TaskContext, opts?: SendOptions): Promise<AgentResponse> {
      const id = opts?.taskId ?? "unknown";
      const waitStart = Date.now();
      hooks.onWait?.(id, engine);
      const release = await sem.acquire();
      if (opts?.signal?.aborted) {
        // Stopped while queued for this engine (or before the call began) — never start it.
        release();
        hooks.onEnd?.(id, engine);
        throw Object.assign(new Error("stopped by the CEO"), { name: "AbortError" });
      }
      const startedAt = new Date().toISOString();
      const waitMs = Date.now() - waitStart;
      hooks.onStart?.(id, engine);
      const rendered = `${prompt}\n\n${formatContext(context)}`;
      let res: AgentResponse | undefined;
      let error: string | undefined;
      try {
        res = await agent.send(prompt, context, opts);
        return res;
      } catch (err) {
        error = (err as Error).message;
        throw err;
      } finally {
        release();
        hooks.onEnd?.(id, engine);
        const output = res?.content ?? "";
        const usage = res?.usage ?? { inputTokens: estimateTokens(rendered), outputTokens: estimateTokens(output), estimated: true };
        hooks.onCall?.({
          taskId: id,
          engine,
          startedAt,
          endedAt: new Date().toISOString(),
          waitMs,
          prompt: rendered,
          output,
          verdict: res?.verdict,
          usage: withCost(usage, price),
          error,
        });
      }
    },
    close: agent.close ? () => agent.close!() : undefined,
  };
}

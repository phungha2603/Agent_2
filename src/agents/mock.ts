import type { Agent, AgentResponse, RoleName, SendOptions, TaskContext } from "../types.js";

/** A deterministic plan for dry runs: 3 epics, 6 subtasks, a few dependencies. */
export const MOCK_PLAN = {
  summary: "Mock plan: data pipeline and model, content, and a quality/release track.",
  // The mock engineer writes notes/<task>.md, so this really checks what it wrote.
  verifyCommands: ["ls notes/*.md"],
  epics: [
    {
      id: "E1",
      rationale: "The data lead owns data + model integration.",
      title: "Data & model",
      owner: "AG-11",
      goal: "Ingest data and serve a model.",
      acceptanceCriteria: ["Pipeline output feeds the model", "Model endpoint returns predictions"],
      subtasks: [
        { id: "E1.S1", rationale: "Data engineering is AG-03's specialty.", inputs: "The goal's data sources.", title: "Data pipeline", owner: "AG-03", description: "Build the ingestion pipeline.", acceptanceCriteria: ["Ingests a sample file"], dependsOn: [] },
        { id: "E1.S2", rationale: "Modeling belongs with the data scientist.", inputs: "E1.S1's pipeline output.", title: "Model", owner: "AG-04", description: "Train a baseline model on the pipeline output.", acceptanceCriteria: ["Baseline accuracy reported"], dependsOn: ["E1.S1"] },
      ],
    },
    {
      id: "E2",
      rationale: "The product manager owns the product story.",
      title: "Content",
      owner: "AG-12",
      goal: "Explain the product.",
      acceptanceCriteria: ["Landing copy exists"],
      subtasks: [{ id: "E2.S1", rationale: "Copywriting fits Content & SEO.", inputs: "The product summary.", title: "Landing copy", owner: "AG-09", description: "Write the landing page copy.", acceptanceCriteria: ["Copy covers the main use case"], dependsOn: [] }],
    },
    {
      id: "E3",
      rationale: "The QA lead owns the release gate.",
      title: "Quality & release",
      owner: "AG-08",
      goal: "Ship it safely.",
      acceptanceCriteria: ["CI is green", "Release notes exist"],
      subtasks: [
        { id: "E3.S1", rationale: "UI work goes to the frontend specialist.", inputs: "The goal's dashboard requirement.", title: "UI shell", owner: "AG-06", description: "Build the UI shell.", acceptanceCriteria: ["UI renders"], dependsOn: [] },
        { id: "E3.S2", rationale: "CI is automation work.", inputs: "E3.S1's UI build.", title: "CI automation", owner: "AG-07", description: "Automate build and test.", acceptanceCriteria: ["CI runs tests"], dependsOn: ["E3.S1"] },
        { id: "E3.S3", rationale: "Releases are the release manager's job.", inputs: "The model and CI outputs.", title: "Release", owner: "AG-10", description: "Cut the release.", acceptanceCriteria: ["Release notes list changes"], dependsOn: ["E1.S2", "E3.S2"] },
      ],
    },
  ],
};

/** Where the mock engineer writes a task's note. */
export function mockNotePath(title: string): string {
  const slug = title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `notes/${slug || "task"}.md`;
}

/** Moves the last movable task of the busiest same-tier queue to the least busy colleague. */
function mockRebalance(prompt: string): { summary: string; moves: unknown[] } {
  const at = prompt.indexOf("LOAD_JSON:");
  const slots: any[] = at === -1 ? [] : JSON.parse(prompt.slice(at + "LOAD_JSON:".length));
  const load = (s: any) => s.running + s.queued;
  const candidates = slots.filter((s) => s.tier !== 1 && s.tasks.some((t: any) => t.movable));
  const busiest = candidates.sort((a, b) => load(b) - load(a))[0];
  if (!busiest || load(busiest) < 2) return { summary: "Phân bổ hiện tại ổn, không cần thay đổi.", moves: [] };
  const target = slots.filter((s) => s.tier === busiest.tier && s.id !== busiest.id).sort((a, b) => load(a) - load(b))[0];
  if (!target || load(target) >= load(busiest) - 1) return { summary: "Phân bổ hiện tại ổn, không cần thay đổi.", moves: [] };
  const task = [...busiest.tasks].reverse().find((t: any) => t.movable);
  return {
    summary: `${busiest.id} đang ôm ${load(busiest)} task trong khi ${target.id} chỉ có ${load(target)}.`,
    moves: [{ taskId: task.id, to: target.id, position: "bottom", reason: `${busiest.id} quá tải (${load(busiest)} task), ${target.id} đang rảnh hơn (${load(target)}).` }],
  };
}

/**
 * Deterministic stand-in agents, used so the orchestrator's state machine
 * (stages, gates, retry/reject loops, planning, scheduling) can be exercised
 * and tested without any API key or the Muse browser session.
 */
export function createMockAgent(role: RoleName): Agent {
  const reply = (prompt: string, context: TaskContext): AgentResponse => {
    switch (role) {
      case "gemini":
        if (prompt.startsWith("REVIEW:")) {
          return { role, verdict: "approve", content: "Gemini review: looks consistent with the brief.\nVERDICT: APPROVE" };
        }
        return { role, content: `Idea brief for "${context.title}": goals, target users, and a rough scope outline.` };
      case "claude":
        if (prompt.startsWith("PLAN:")) {
          return { role, content: JSON.stringify(MOCK_PLAN) };
        }
        if (prompt.startsWith("REBALANCE:")) {
          return { role, content: JSON.stringify(mockRebalance(prompt)) };
        }
        if (prompt.startsWith("REVIEW:")) {
          return { role, verdict: "approve", content: "Claude sign-off: architecture followed, no blocking concerns.\nVERDICT: APPROVE" };
        }
        return {
          role,
          content:
            `Architecture spec for "${context.title}" (mock).\n\n` +
            `Files: ${mockNotePath(context.title)} — a short implementation note naming the task.\n` +
            "Build order: write the note, then run the plan's verification commands.\n" +
            "Acceptance: each criterion is checked against the note by the verification step; no other files are needed for this dry run.\n" +
            "FILES: notes/*.md",
        };
      case "muse":
        // One file per task, like real work: tasks writing the same file
        // would (rightly) trip the "overwritten by another task" check.
        return { role, content: `FILE: ${mockNotePath(context.title)}\n\`\`\`md\n# ${context.title}\n\nMock implementation note.\n\`\`\`\n` };
      default:
        return { role, content: "" };
    }
  };
  // MOCK_DELAY_MS makes each mock call take that long, streaming its reply
  // word by word — enough to watch the dashboard's queues, parallelism and
  // live output in a dry run without spending any real quota.
  const delayMs = Number(process.env.MOCK_DELAY_MS ?? 0) || 0;
  return {
    role,
    async send(prompt: string, context: TaskContext, opts?: SendOptions): Promise<AgentResponse> {
      const res = reply(prompt, context);
      if (delayMs > 0) {
        const words = res.content.split(/(?<=\s)/);
        for (const w of words) {
          await new Promise((r) => setTimeout(r, delayMs / words.length));
          if (opts?.signal?.aborted) {
            const err = new Error("stopped by the CEO");
            err.name = "AbortError";
            throw err;
          }
          opts?.onChunk?.(w);
        }
      } else {
        opts?.onChunk?.(res.content);
      }
      return res;
    },
  };
}

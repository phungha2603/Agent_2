import { describe, expect, it } from "vitest";
import { buildPlanPrompt, commandWarnings, draftAndReviewPlan, materializePlan, parsePlan, type Department, type WorkPlanRecord } from "../src/orchestrator/planner.js";
import { MOCK_PLAN, createMockAgent } from "../src/agents/mock.js";
import type { Agent, AgentResponse } from "../src/types.js";

const DEPTS: Department[] = [
  { id: "AG-01", name: "Boss", tier: 1 },
  { id: "AG-05", name: "Lead A", tier: 2 },
  { id: "AG-11", name: "Lead B", tier: 2 },
  { id: "AG-08", name: "Lead C", tier: 2 },
  { id: "AG-12", name: "Lead D", tier: 2 },
  ...["AG-02", "AG-03", "AG-04", "AG-06", "AG-07", "AG-09", "AG-10"].map((id) => ({ id, name: `Staff ${id}`, tier: 3 as const })),
];

const plan = (epics: unknown[]) => JSON.stringify({ summary: "s", epics, verifyCommands: ["npm test"] });
const sub = (id: string, owner: string, dependsOn: string[] = []) => ({ id, title: id, owner, description: "d", acceptanceCriteria: ["c"], dependsOn });
const epic = (id: string, owner: string, subtasks: unknown[]) => ({ id, title: id, owner, goal: "g", acceptanceCriteria: ["ec"], subtasks });

describe("parsePlan", () => {
  it("parses the mock plan, including one wrapped in a ```json fence with prose around it", () => {
    const { plan: p, notes } = parsePlan("Here you go:\n```json\n" + JSON.stringify(MOCK_PLAN) + "\n```\nThanks", DEPTS);
    expect(p.epics).toHaveLength(3);
    expect(p.epics.flatMap((e) => e.subtasks)).toHaveLength(6);
    expect(notes).toEqual([]);
  });

  it("reassigns owners from the wrong tier and says so", () => {
    const { plan: p, notes } = parsePlan(plan([epic("E1", "AG-03", [sub("E1.S1", "AG-05")])]), DEPTS);
    expect(DEPTS.find((d) => d.id === p.epics[0].owner)?.tier).toBe(2);
    expect(DEPTS.find((d) => d.id === p.epics[0].subtasks[0].owner)?.tier).toBe(3);
    expect(notes).toHaveLength(2);
  });

  it("drops unknown and self dependencies with a note", () => {
    const { plan: p, notes } = parsePlan(plan([epic("E1", "AG-05", [sub("E1.S1", "AG-03", ["E1.S1", "E9.S9"])])]), DEPTS);
    expect(p.epics[0].subtasks[0].dependsOn).toEqual([]);
    expect(notes[0]).toMatch(/dropped/);
  });

  it("throws on things the planner should fix itself: cycles, bad JSON, missing criteria, too many subtasks", () => {
    expect(() => parsePlan(plan([epic("E1", "AG-05", [sub("A", "AG-03", ["B"]), sub("B", "AG-04", ["A"])])]), DEPTS)).toThrow(/cycle/);
    expect(() => parsePlan("not json at all", DEPTS)).toThrow(/JSON/);
    expect(() => parsePlan(plan([epic("E1", "AG-05", [{ ...sub("A", "AG-03"), acceptanceCriteria: [] }])]), DEPTS)).toThrow(/acceptanceCriteria/);
    const many = Array.from({ length: 9 }, (_, i) => sub(`S${i}`, "AG-03"));
    expect(() => parsePlan(plan([epic("E1", "AG-05", many)]), DEPTS)).toThrow(/limit/);
  });
});

describe("draftAndReviewPlan", () => {
  it("tells Claude it has no tools when it tries to run one instead of planning", async () => {
    const prompts: string[] = [];
    let n = 0;
    const claude: Agent = {
      role: "claude",
      async send(prompt: string): Promise<AgentResponse> {
        prompts.push(prompt);
        return n++ === 0 ? { role: "claude", content: "I'll inspect the files first.\n\n**Tool: bash**\n```\nls -la /project\n```" } : { role: "claude", content: JSON.stringify(MOCK_PLAN) };
      },
    };
    const res = await draftAndReviewPlan({ claude, gemini: createMockAgent("gemini") }, "Fix the app", DEPTS, { maxRounds: 2 });
    expect(res.plan.epics).toHaveLength(3);
    expect(prompts[0]).toMatch(/no tools in this step/);
    expect(prompts[1]).toMatch(/tried to run a tool or command/);
  });

  it("feeds Gemini's rejection back to Claude for a revised plan", async () => {
    const prompts: string[] = [];
    const claude: Agent = {
      role: "claude",
      async send(prompt): Promise<AgentResponse> {
        prompts.push(prompt);
        return { role: "claude", content: JSON.stringify(MOCK_PLAN) };
      },
    };
    let reviews = 0;
    const gemini: Agent = {
      role: "gemini",
      async send(): Promise<AgentResponse> {
        reviews++;
        return reviews === 1 ? { role: "gemini", verdict: "reject", content: "E2 is off-goal." } : { role: "gemini", verdict: "approve", content: "ok" };
      },
    };
    const res = await draftAndReviewPlan({ claude, gemini }, "goal", DEPTS, { maxRounds: 3 });
    expect(res.rounds).toBe(2);
    expect(res.unresolvedReview).toBeUndefined();
    expect(prompts[1]).toContain("E2 is off-goal.");
    expect(prompts[1]).toContain("Your previous plan");
  });

  it("asks again when the reply isn't usable JSON, and hands the CEO Gemini's last objection if rounds run out", async () => {
    let calls = 0;
    const claude: Agent = {
      role: "claude",
      async send(): Promise<AgentResponse> {
        calls++;
        return { role: "claude", content: calls === 1 ? "Sure! Here's my plan in prose." : JSON.stringify(MOCK_PLAN) };
      },
    };
    const gemini: Agent = { role: "gemini", async send() { return { role: "gemini", verdict: "reject", content: "Still missing tests." }; } };
    const res = await draftAndReviewPlan({ claude, gemini }, "goal", DEPTS, { maxRounds: 2 });
    expect(calls).toBe(2);
    expect(res.unresolvedReview).toBe("Still missing tests.");
  });

  it("works end to end with the mock agents", async () => {
    const res = await draftAndReviewPlan({ claude: createMockAgent("claude"), gemini: createMockAgent("gemini") }, "goal", DEPTS, { maxRounds: 1 });
    expect(res.plan.epics).toHaveLength(3);
  });
});

describe("materializePlan", () => {
  it("creates one task per subtask plus one integration task per epic, wired by dependencies", () => {
    const { plan: p } = parsePlan(JSON.stringify(MOCK_PLAN), DEPTS);
    const record: WorkPlanRecord = { id: "plan-1", goal: "Ship it", status: "awaiting_approval", createdAt: "", updatedAt: "", ...p };
    const tasks = materializePlan(record);

    expect(tasks).toHaveLength(9);
    expect(tasks.every((t) => t.stage === "architecture")).toBe(true);
    const byTitle = (prefix: string) => tasks.find((t) => t.context.title.startsWith(prefix))!;
    expect(byTitle("E1.S2").dependsOn).toEqual([byTitle("E1.S1").id]);
    expect(byTitle("E3.S3").dependsOn).toEqual([byTitle("E1.S2").id, byTitle("E3.S2").id]);

    const integration = tasks.find((t) => t.planRef?.epicId === "E1" && !t.planRef.subtaskId)!;
    expect(integration.slotId).toBe("AG-11");
    expect(integration.dependsOn).toEqual([byTitle("E1.S1").id, byTitle("E1.S2").id]);
    expect(byTitle("E1.S1").context.acceptanceCriteria).toEqual(["Ingests a sample file"]);
    expect(byTitle("E1.S1").context.sharedBrief).toContain("Ship it");
    expect(byTitle("E1.S1").context.sharedBrief).toContain("E2.S1"); // teammates' work listed, so it isn't duplicated
    expect(record.epics![0].subtasks[0].taskId).toBe(byTitle("E1.S1").id);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(9);
  });
});


describe("per-task verification commands", () => {
  const planJson = JSON.stringify({
    summary: "s",
    verifyCommands: ["swift build", "swift test"],
    epics: [
      {
        id: "E1", title: "E1", owner: "AG-05", goal: "g", acceptanceCriteria: ["ec"], verifyCommands: ["bash scripts/test.sh"],
        subtasks: [
          { id: "E1.S1", title: "py", owner: "AG-03", description: "d", acceptanceCriteria: ["c"], dependsOn: [], verifyCommands: ["python3 -m pytest -q content/scripts", "swift test"] },
          { id: "E1.S2", title: "sw", owner: "AG-04", description: "d", acceptanceCriteria: ["c"], dependsOn: [] },
        ],
      },
    ],
  });

  it("gives each task the baseline plus its own commands, without duplicates", () => {
    const { plan: p } = parsePlan(planJson, DEPTS);
    const record: WorkPlanRecord = { id: "plan-x", goal: "g", status: "approved", createdAt: "", updatedAt: "", ...p };
    const tasks = materializePlan(record, { verifyCwd: "/proj", verifyCommands: p.verifyCommands! });
    const cmds = (title: string) => tasks.find((t) => t.context.title.startsWith(title))!.projectConfig!.verifyCommands;
    expect(cmds("E1.S1")).toEqual(["swift build", "swift test", "python3 -m pytest -q content/scripts"]);
    expect(cmds("E1.S2")).toEqual(["swift build", "swift test"]);
    expect(cmds("E1 · ")).toEqual(["swift build", "swift test", "bash scripts/test.sh"]);
  });

  it("warns when every iOS build targets only the generic simulator, not a concrete one like Xcode's Run", () => {
    expect(commandWarnings(["xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' build"])).toHaveLength(1);
    expect(
      commandWarnings([
        "xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' build",
        "xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17' build",
      ]),
    ).toEqual([]);
    expect(commandWarnings(["swift test", "xcodebuild -list -project App.xcodeproj"])).toEqual([]);
  });

  it("tells Claude about per-task commands, concrete simulators and this machine's simulators", () => {
    const prompt = buildPlanPrompt("goal", DEPTS, { maxEpics: 3, maxSubtasks: 8 }, undefined, "installed iOS simulators: iPhone 17.");
    expect(prompt).toMatch(/verifyCommands on a subtask or epic/);
    expect(prompt).toMatch(/platform=iOS Simulator,name=/);
    expect(prompt).toMatch(/This machine: installed iOS simulators: iPhone 17\./);
  });
});

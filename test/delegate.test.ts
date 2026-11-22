import { describe, expect, it } from "vitest";
import { decomposeGoalForDepartments, parseDepartmentGoals } from "../src/orchestrator/delegate.js";
import type { Agent, AgentResponse, TaskContext } from "../src/types.js";

describe("parseDepartmentGoals", () => {
  it("splits a reply on DEPT: markers, like FILE: markers split a diff", () => {
    const text =
      "DEPT: AG-02\nResearch competitor pricing for the new tier.\n\n" +
      "DEPT: AG-05\nDesign the billing service's API and schema.\nKeep it stateless.\n";

    const goals = parseDepartmentGoals(text);
    expect(goals).toEqual({
      "AG-02": "Research competitor pricing for the new tier.",
      "AG-05": "Design the billing service's API and schema.\nKeep it stateless.",
    });
  });

  it("ignores prose before the first marker and drops empty sub-goals", () => {
    const text = "Thinking out loud...\n\nDEPT: AG-01\n\nDEPT: AG-02\nActual goal here.\n";
    expect(parseDepartmentGoals(text)).toEqual({ "AG-02": "Actual goal here." });
  });

  it("returns an empty map for a reply with no DEPT: markers", () => {
    expect(parseDepartmentGoals("I would split this up by department.")).toEqual({});
  });
});

describe("decomposeGoalForDepartments", () => {
  it("returns only the departments the boss's reply actually covered", async () => {
    const boss: Agent = {
      role: "claude",
      async send(prompt: string, context: TaskContext): Promise<AgentResponse> {
        expect(prompt).toContain("AG-02");
        expect(context.title).toBe("Launch a referral program");
        return {
          role: "claude",
          content: "DEPT: AG-02\nSurvey users on referral incentives.\n",
        };
      },
    };

    const result = await decomposeGoalForDepartments(boss, "Launch a referral program", [
      { id: "AG-02", name: "AI Market Researcher" },
      { id: "AG-05", name: "AI Backend Architect" },
    ]);

    expect(result.goals).toEqual({ "AG-02": "Survey users on referral incentives." });
    expect(result.goals["AG-05"]).toBeUndefined();
  });
});

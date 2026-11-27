import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { advance, createTask, requestRevision, type PipelineConfig } from "../src/orchestrator/pipeline.js";
import { createMockAgent } from "../src/agents/mock.js";
import { formatSurvey, surveyProject } from "../src/verify/survey.js";
import type { Agent, AgentResponse, TaskContext } from "../src/types.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "review-guards-"));

describe("project survey for the planner", () => {
  it("reports broken files and test classes that contain no tests", async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, "Tests"), { recursive: true });
    writeFileSync(path.join(dir, "Tests", "EmptyTests.swift"), "import XCTest\nfinal class EmptyTests: XCTestCase {\n    private let x = 1\n}\n");
    writeFileSync(path.join(dir, "Tests", "RealTests.swift"), "import XCTest\nfinal class RealTests: XCTestCase {\n    func testA() {}\n}\n");
    writeFileSync(path.join(dir, "data.json"), '{"a": 1}\nVerification log: ok');
    mkdirSync(path.join(dir, ".build"));
    writeFileSync(path.join(dir, ".build", "junk.json"), "not json");
    const s = (await surveyProject(dir))!;
    expect(s.emptyTests).toEqual(["Tests/EmptyTests.swift"]);
    expect(s.broken.map((b) => b.path)).toEqual(["data.json"]); // .build is skipped
    expect(formatSurvey(s)).toMatch(/no test functions \(1\): Tests\/EmptyTests\.swift/);
  });
});

describe("CEO requests reach the reviewers", () => {
  it("keeps a revision request in the context through implementation and both reviews", async () => {
    const seen: Record<string, TaskContext> = {};
    const spy = (role: "gemini" | "claude"): Agent => {
      const base = createMockAgent(role);
      return {
        role,
        async send(prompt: string, ctx: TaskContext, opts): Promise<AgentResponse> {
          if (prompt.startsWith("REVIEW:")) seen[role] = ctx;
          return base.send(prompt, ctx, opts);
        },
      };
    };
    const cfg: PipelineConfig = { verify: { cwd: tmp(), commands: ["true"] }, maxImplementationAttempts: 2, maxReviewRejections: 2 };
    const task = createTask("Revise");
    task.stage = "checkpoint_final";
    task.context.architectureSpec = "guide\nFILES: NOTES.md";
    requestRevision(task, "validate-xcodeproj.py must FAIL when SDKROOT is missing");
    const agents = { gemini: spy("gemini"), claude: spy("claude"), muse: createMockAgent("muse") };
    while (task.stage !== "checkpoint_final") await advance(task, agents, cfg);
    expect(seen.gemini.ceoRequests).toEqual(["validate-xcodeproj.py must FAIL when SDKROOT is missing"]);
    expect(seen.claude.ceoRequests).toEqual(["validate-xcodeproj.py must FAIL when SDKROOT is missing"]);
  });

  it("warns when a file changed on disk after the attempt wrote it, before anyone reviews it", async () => {
    const cfg: PipelineConfig = { verify: { cwd: tmp(), commands: ["true"] }, maxImplementationAttempts: 2, maxReviewRejections: 2 };
    const task = createTask("Overwritten");
    task.stage = "review_gemini";
    task.context.implementationFiles = ["a.txt"];
    task.context.implementationDiff = "FILE: a.txt\n```\nmine\n```";
    writeFileSync(path.join(cfg.verify.cwd, "a.txt"), "someone else's\n");
    await advance(task, { gemini: createMockAgent("gemini"), claude: createMockAgent("claude"), muse: createMockAgent("muse") }, cfg);
    expect(task.alerts?.find((a) => a.kind === "files_overwritten")?.level).toBe("warn");
  });
});

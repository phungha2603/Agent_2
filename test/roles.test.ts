import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLES, TEAMS, roleById, teamMembers } from "../src/org/roles.js";
import { PLAYBOOK_DIR, SECTION_HEADINGS, STAGE_SECTIONS, formatGuidance, parsePlaybook } from "../src/org/playbooks.js";
import { isTestFile, runRoleChecks } from "../src/verify/roleChecks.js";
import { buildPlanPrompt, parsePlan, teamRoster, type Department } from "../src/orchestrator/planner.js";
import { withRole } from "../src/orchestrator/pipeline.js";
import { VERDICT_INSTRUCTION } from "../src/agents/verdict.js";
import { createRoleSupport } from "../src/org/runtime.js";
import type { TaskRecord } from "../src/types.js";

const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
});

describe("org chart", () => {
  it("has 16 roles: one boss, one lead per team, everyone else staff in a team", () => {
    expect(ROLES).toHaveLength(16);
    expect(new Set(ROLES.map((r) => r.id)).size).toBe(16);
    expect(ROLES.filter((r) => r.tier === 1).map((r) => r.id)).toEqual(["AG-01"]);
    for (const team of TEAMS.filter((t) => t.id !== "exec")) {
      expect(roleById(team.leadId)?.tier).toBe(2);
      expect(roleById(team.leadId)?.team).toBe(team.id);
      expect(teamMembers(team.id).length).toBeGreaterThanOrEqual(2);
    }
    expect(ROLES.filter((r) => r.tier === 2)).toHaveLength(4);
  });

  it("keeps the original ten ids so existing queues, tasks and gates still match", () => {
    for (let i = 1; i <= 10; i++) expect(roleById(`AG-${String(i).padStart(2, "0")}`)).toBeDefined();
  });

  it("gives every role a playbook with every section, and nothing else in the folder pretends to be one", () => {
    const files = readdirSync(PLAYBOOK_DIR).filter((f) => /^AG-\d+\.md$/.test(f));
    expect(files.sort()).toEqual(ROLES.map((r) => `${r.id}.md`).sort());
    for (const role of ROLES) {
      const pb = parsePlaybook(role.id, readFileSync(path.join(PLAYBOOK_DIR, `${role.id}.md`), "utf8"));
      expect(pb.summary, role.id).not.toBe("");
      for (const key of ["skills", "design", "review", "boundaries"] as const) expect(pb.sections[key], `${role.id} ${key}`).toBeTruthy();
      // every heading used is one the parser knows (a typo would silently drop a section)
      const headings = [...pb.raw.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
      for (const h of headings) expect(Object.keys(SECTION_HEADINGS), `${role.id}: "${h}"`).toContain(h);
    }
  });
});

describe("role guidance", () => {
  const pb = parsePlaybook(
    "AG-14",
    "# x\n> Tóm tắt: s\n\n## Năng lực\nSKILLS\n## Khi thiết kế\nDESIGN\n## Khi viết code\nCODE\n## Khi review\nREVIEW\n## Không làm\nBOUNDS\n## Bài học\n- OLD LESSON\n",
  );

  it("gives each step only the sections it uses, with accepted lessons after the curated ones", () => {
    const impl = formatGuidance("AG-14", pb, "implementation", ["NEW LESSON"])!;
    expect(impl).toContain("CODE");
    expect(impl).not.toContain("REVIEW");
    expect(impl.indexOf("OLD LESSON")).toBeLessThan(impl.indexOf("NEW LESSON"));
    const review = formatGuidance("AG-14", pb, "review")!;
    expect(review).toContain("REVIEW");
    expect(review).not.toContain("CODE");
    expect(STAGE_SECTIONS.ideation).not.toContain("lessons");
  });

  it("is added after the step's own instructions and before a review's verdict instruction", () => {
    const prompt = `REVIEW: check it. ${VERDICT_INSTRUCTION}`;
    const out = withRole(prompt, "\n\nROLE PLAYBOOK x");
    expect(out.startsWith("REVIEW:")).toBe(true);
    expect(out.endsWith(VERDICT_INSTRUCTION)).toBe(true);
    expect(out).toContain("ROLE PLAYBOOK x");
    expect(withRole("PLAN it", undefined)).toBe("PLAN it");
  });

  it("only applies to tasks that belong to a known role, and routes models by tier when configured", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "roles-"));
    process.chdir(dir);
    const support = createRoleSupport({ light: "light-model", strong: "strong-model" });
    const task = (slotId?: string) => ({ slotId, context: { title: "t" } }) as unknown as TaskRecord;
    expect(await support.guidance(task(undefined), "architecture")).toBeUndefined();
    expect(await support.guidance(task("AG-14"), "architecture")).toContain("AG-14");
    expect(support.claudeModel(task("AG-15"), "review")).toBe("strong-model");
    expect(support.claudeModel(task("AG-09"), "architecture")).toBe("light-model");
    expect(support.claudeModel(task("AG-09"), "review")).toBeUndefined(); // reviews never get the light model
    expect(support.claudeModel(task("AG-13"), "architecture")).toBeUndefined();
    expect(createRoleSupport().claudeModel(task("AG-15"), "review")).toBeUndefined(); // nothing configured, nothing changes
  });
});

describe("role checks", () => {
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "rolecheck-"));
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), c);
    }
    return dir;
  };

  it("fails on a hard-coded secret but not on a placeholder or an env lookup", async () => {
    const cwd = project({ "a.py": 'API_KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz123456"\n', "b.py": 'api_key = "changeme-please"\nkey = os.environ["API_KEY"]\n' });
    const bad = await runRoleChecks(["secrets"], { cwd, files: ["a.py"], commands: [] });
    expect(bad).toHaveLength(1);
    expect(bad[0].level).toBe("fail");
    expect(bad[0].text).toContain("a.py:1");
    expect(await runRoleChecks(["secrets"], { cwd, files: ["b.py"], commands: [] })).toEqual([]);
  });

  it("fails on stubs left in source, not in tests or on abstract-method idioms", async () => {
    const cwd = project({
      "src/a.swift": 'func f() -> Int { fatalError("TODO") }\n',
      "src/b.py": "class A:\n    def f(self):\n        raise NotImplementedError\n",
      "tests/test_a.py": "# TODO: implement more cases\n",
    });
    const out = await runRoleChecks(["stubs"], { cwd, files: ["src/a.swift", "src/b.py", "tests/test_a.py"], commands: [] });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("src/a.swift");
  });

  it("warns when new code comes without any test, and only for code", async () => {
    const cwd = project({ "src/api.ts": "export const x = 1;\n", "src/api.test.ts": "", "README.md": "" });
    expect((await runRoleChecks(["tests"], { cwd, files: ["src/api.ts"], commands: [] }))[0]?.level).toBe("warn");
    expect(await runRoleChecks(["tests"], { cwd, files: ["src/api.ts", "src/api.test.ts"], commands: [] })).toEqual([]);
    expect(await runRoleChecks(["tests"], { cwd, files: ["README.md"], commands: [] })).toEqual([]);
  });

  it("recognises test files across languages", () => {
    for (const f of ["Tests/AppTests/FooTests.swift", "tests/test_x.py", "src/x.test.ts", "pkg/x_test.go", "AppUITests/LaunchTests.swift", "__tests__/a.js"]) expect(isTestFile(f), f).toBe(true);
    for (const f of ["src/Test.md", "src/testing.ts", "App/ContentView.swift"]) expect(isTestFile(f), f).toBe(false);
  });

  it("warns when an iOS build only targets the generic simulator", async () => {
    const cwd = project({ "App/View.swift": "" });
    const generic = await runRoleChecks(["ios_destination"], { cwd, files: ["App/View.swift"], commands: ["xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' build"] });
    expect(generic[0]?.level).toBe("warn");
    const concrete = await runRoleChecks(["ios_destination"], { cwd, files: ["App/View.swift"], commands: ["xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17' build"] });
    expect(concrete).toEqual([]);
  });
});

describe("team-aware planning", () => {
  const depts: Department[] = [
    { id: "AG-01", name: "Boss", tier: 1 },
    { id: "AG-05", name: "Tech Lead", tier: 2, team: "Eng" },
    { id: "AG-11", name: "Data Lead", tier: 2, team: "Data" },
    { id: "AG-13", name: "Backend", tier: 3, team: "Eng", summary: "APIs" },
    { id: "AG-14", name: "iOS", tier: 3, team: "Eng" },
    { id: "AG-03", name: "Data Eng", tier: 3, team: "Data" },
  ];
  const plan = (owner: string, subOwner: string) =>
    JSON.stringify({ summary: "s", verifyCommands: ["npm test"], epics: [{ id: "E1", title: "E1", owner, goal: "g", acceptanceCriteria: ["c"], subtasks: [{ id: "E1.S1", title: "s", owner: subOwner, description: "d", acceptanceCriteria: ["c"], dependsOn: [] }] }] });

  it("lists each team with its lead and staff in the prompt, plus the boss playbook", () => {
    const prompt = buildPlanPrompt("goal", depts, { maxEpics: 3, maxSubtasks: 8 }, undefined, undefined, undefined, "BOSS PLAYBOOK");
    expect(teamRoster(depts)[0]).toContain('Team "Eng"');
    expect(prompt).toContain("Lead: AG-05 (Tech Lead)");
    expect(prompt).toContain("AG-13 (Backend: APIs)");
    expect(prompt).toContain("BOSS PLAYBOOK");
    expect(prompt.indexOf("BOSS PLAYBOOK")).toBeLessThan(prompt.indexOf("Company-wide goal:"));
  });

  it("notes a borrowed staff member and reassigns an invalid owner within the epic's team", () => {
    expect(parsePlan(plan("AG-05", "AG-03"), depts).notes[0]).toMatch(/borrowed from team "Data"/);
    const { plan: p, notes } = parsePlan(plan("AG-11", "nobody"), depts);
    expect(p.epics[0].subtasks[0].owner).toBe("AG-03");
    expect(notes[0]).toMatch(/reassigned to AG-03/);
  });
});

describe("lessons", () => {
  it("proposes a lesson only for a task that was sent back, and keeps accepted ones per role", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lessons-"));
    process.chdir(dir);
    vi.resetModules();
    const lessons = await import("../src/org/lessons.js");
    const clean = { id: "t1", slotId: "AG-14", context: { title: "Clean" }, feedbackLog: [] } as unknown as TaskRecord;
    expect(await lessons.proposeLessonFrom(clean)).toBeUndefined();
    const bumpy = { id: "t2", slotId: "AG-14", context: { title: "Bumpy" }, feedbackLog: [{ at: "", by: "claude", kind: "review", text: "Missing Identifiable id on Word." }] } as unknown as TaskRecord;
    const pending = await lessons.proposeLessonFrom(bumpy);
    expect(pending?.status).toBe("pending");
    expect(await lessons.proposeLessonFrom(bumpy)).toBeUndefined(); // not proposed twice
    expect(await lessons.acceptedLessons("AG-14")).toEqual([]);
    await lessons.decideLesson(pending!.id, "accept", "Model dùng trong List phải Identifiable.");
    await lessons.addLesson("AG-13", "Other role's lesson");
    expect(await lessons.acceptedLessons("AG-14")).toEqual(["Model dùng trong List phải Identifiable."]);
  });
});

describe("roles in the pipeline", () => {
  it("sends the role's playbook with each step and fails verification on a role check, recording why", async () => {
    const { advance, createTask } = await import("../src/orchestrator/pipeline.js");
    const { createMockAgent } = await import("../src/agents/mock.js");
    const cwd = mkdtempSync(path.join(tmpdir(), "role-pipeline-"));
    process.chdir(cwd);
    const prompts: string[] = [];
    const spy = (role: "gemini" | "claude" | "muse", reply?: string) => {
      const base = createMockAgent(role);
      return {
        role,
        async send(prompt: string, ctx: any, opts?: any) {
          prompts.push(prompt);
          if (role === "claude" && !prompt.startsWith("REVIEW:")) {
            return { role, content: "Architecture guide (test): write notes/key.py holding the service token lookup, then run the verify commands. Every criterion is checked by verification. Build order: the token module first, nothing else depends on it. Acceptance: the verify commands pass and the file parses.\nFILES: notes/*.py" };
          }
          return reply ? { role, content: reply } : base.send(prompt, ctx, opts);
        },
      };
    };
    // The engineer leaves a hard-coded key in a file the guide allows.
    const muse = spy("muse", 'FILE: notes/key.py\n```python\nTOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"\n```\n');
    const task = createTask("Backend secret task");
    task.slotId = "AG-13";
    task.stage = "architecture";
    task.context.ideaBrief = "brief";
    const cfg = { verify: { cwd, commands: ["true"] }, maxImplementationAttempts: 2, maxReviewRejections: 2, roles: createRoleSupport() };
    const a = { gemini: spy("gemini"), claude: spy("claude"), muse };
    await advance(task, a, cfg); // architecture
    expect(prompts.at(-1)).toContain("ROLE PLAYBOOK — this task belongs to AG-13");
    await advance(task, a, cfg); // architecture review
    expect(prompts.at(-1)!.startsWith("REVIEW:")).toBe(true);
    expect(prompts.at(-1)).toContain("AG-13");
    await advance(task, a, cfg); // implementation
    expect(prompts.at(-1)).toContain("When writing code");
    await advance(task, a, cfg); // verification: the commands pass, the role check doesn't
    expect(task.stage).toBe("implementation");
    expect(task.context.verificationLog).toContain("Role checks (AG-13 Backend Developer): 1 FAILED");
    expect(task.alerts?.some((x) => x.kind === "role_checks")).toBe(true);
    expect(task.feedbackLog?.at(-1)?.kind).toBe("role_check");
  });
});

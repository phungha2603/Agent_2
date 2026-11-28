import { describe, expect, it } from "vitest";
import { quotaResumeAt } from "../src/orchestrator/quota.js";
import { runVerification } from "../src/verify/runner.js";

describe("quotaResumeAt", () => {
  const now = new Date(2026, 10, 25, 18, 21); // 18:21 local
  it("reads the reset time from the Claude CLI's usage-limit message (the one that stalled the VocabApp run)", () => {
    const at = quotaResumeAt("claude CLI reported an error: You've hit your 5-hour limit · resets 7:50pm (Asia/Saigon) · out of usage credits", now)!;
    expect([at.getHours(), at.getMinutes()]).toEqual([19, 52]); // 7:50pm + 2 min buffer
    expect(at.getDate()).toBe(25);
  });
  it("rolls a time that has already passed today to tomorrow, and handles 24h / am forms", () => {
    expect(quotaResumeAt("usage limit reached, resets 9am", now)!.getDate()).toBe(26);
    expect(quotaResumeAt("You've hit your limit · resets 23:00", now)!.getHours()).toBe(23);
  });
  it("leaves every other error to the normal retries", () => {
    expect(quotaResumeAt("MCP error -32000: Connection closed", now)).toBeUndefined();
    expect(quotaResumeAt("You've hit your 5-hour limit", now)).toBeUndefined(); // no time given
  });
});

describe("runVerification timeout", () => {
  it("kills a command that runs past its timeout instead of holding the workspace forever", async () => {
    const res = await runVerification({ cwd: process.cwd(), commands: ["sleep 5"], timeoutSec: 1 });
    expect(res.passed).toBe(false);
    expect(res.log).toMatch(/timed out after 1s/);
  });
});

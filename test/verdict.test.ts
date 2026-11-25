import { describe, expect, it } from "vitest";
import { parseVerdict, sendReview, verdictFor } from "../src/agents/verdict.js";
import type { Agent, AgentResponse } from "../src/types.js";

describe("parseVerdict", () => {
  it("reads only the closing VERDICT line, in any common formatting", () => {
    expect(parseVerdict("Looks fine.\nVERDICT: APPROVE")).toBe("approve");
    expect(parseVerdict("Missing tests.\n\n**VERDICT: REJECT**")).toBe("reject");
    expect(parseVerdict("ok\n`verdict: approved`\n")).toBe("approve");
    expect(parseVerdict("no\nVerdict - Rejected.")).toBe("reject");
  });

  it("never guesses from prose — the words that used to flip the result give no verdict at all", () => {
    // "REJECTED" used to read as an approval (\breject\b doesn't match it) …
    expect(parseVerdict("REJECTED\n\nThe architecture spec is completely empty.")).toBeUndefined();
    // … and a sentence merely containing "reject" used to read as a rejection.
    expect(parseVerdict("I would not reject this; it is solid. Approve.")).toBeUndefined();
    expect(parseVerdict("")).toBeUndefined();
  });

  it("ignores a VERDICT line buried far above the end", () => {
    const text = ["VERDICT: APPROVE", "a", "b", "c", "d", "e", "f"].join("\n");
    expect(parseVerdict(text)).toBeUndefined();
  });

  it("is only set for review prompts", () => {
    expect(verdictFor("REVIEW: check", "x\nVERDICT: REJECT")).toBe("reject");
    expect(verdictFor("Write the spec", "x\nVERDICT: REJECT")).toBeUndefined();
  });
});

function scripted(replies: string[]): Agent & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    role: "gemini",
    prompts,
    async send(prompt: string): Promise<AgentResponse> {
      prompts.push(prompt);
      const content = replies.shift() ?? "";
      return { role: "gemini", content, verdict: verdictFor(prompt, content) };
    },
  };
}

describe("sendReview", () => {
  it("passes a clear verdict straight through, with one call", async () => {
    const agent = scripted(["Good.\nVERDICT: APPROVE"]);
    const res = await sendReview(agent, "REVIEW: x", { title: "t" });
    expect(res.verdict).toBe("approve");
    expect(agent.prompts).toHaveLength(1);
  });

  it("asks once more for the verdict line, sending only the review text", async () => {
    const agent = scripted(["REJECTED — the spec is empty.", "VERDICT: REJECT"]);
    const res = await sendReview(agent, "REVIEW: x", { title: "t", architectureSpec: "huge context" });
    expect(res.verdict).toBe("reject");
    expect(res.content).toBe("REJECTED — the spec is empty.");
    expect(agent.prompts[1]).toContain("REJECTED — the spec is empty.");
  });

  it("counts a review that never gives a readable verdict as a rejection", async () => {
    const agent = scripted(["Hmm, hard to say.", "Still thinking."]);
    const res = await sendReview(agent, "REVIEW: x", { title: "t" });
    expect(res.verdict).toBe("reject");
    expect(res.content).toMatch(/no readable VERDICT line/);
  });
});

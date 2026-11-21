import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { advance, createTask } from "../src/orchestrator/pipeline.js";
import { createMockAgent } from "../src/agents/mock.js";
import type { PipelineConfig } from "../src/orchestrator/pipeline.js";

function agents() {
  return { gemini: createMockAgent("gemini"), claude: createMockAgent("claude"), muse: createMockAgent("muse") };
}

function baseConfig(visual: PipelineConfig["visual"]): PipelineConfig {
  return {
    verify: { cwd: mkdtempSync(path.join(tmpdir(), "ai-company-visual-test-")), commands: ["true"] },
    maxImplementationAttempts: 3,
    maxReviewRejections: 3,
    visual,
  };
}

describe("visual review hooks", () => {
  it("generates a reference image during ideation when configured", async () => {
    const generateImage = vi.fn().mockResolvedValue("/tmp/ref.png");
    const config = baseConfig({
      referenceImagePrompt: "a cyberpunk street",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      devCommand: "npm run dev",
      devUrl: "http://localhost:5173",
      generateImage,
      captureScreenshot: vi.fn(),
    });
    const task = createTask("Build a scene");

    await advance(task, agents(), config);

    expect(generateImage).toHaveBeenCalledWith("a cyberpunk street", "/tmp/ref.png");
    expect(task.context.referenceImagePath).toBe("/tmp/ref.png");
  });

  it("doesn't regenerate the reference image once it already exists on the task", async () => {
    const generateImage = vi.fn().mockResolvedValue("/tmp/ref.png");
    const config = baseConfig({
      referenceImagePrompt: "a cyberpunk street",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      devCommand: "npm run dev",
      devUrl: "http://localhost:5173",
      generateImage,
      captureScreenshot: vi.fn(),
    });
    const task = createTask("Build a scene");
    task.context.referenceImagePath = "/tmp/ref.png"; // e.g. set by a prior attempt

    await advance(task, agents(), config);

    expect(generateImage).not.toHaveBeenCalled();
  });

  it("degrades gracefully (and still advances) if image generation fails", async () => {
    const generateImage = vi.fn().mockRejectedValue(new Error("quota exceeded"));
    const config = baseConfig({
      referenceImagePrompt: "a cyberpunk street",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      devCommand: "npm run dev",
      devUrl: "http://localhost:5173",
      generateImage,
      captureScreenshot: vi.fn(),
    });
    const task = createTask("Build a scene");

    await advance(task, agents(), config);

    expect(task.stage).toBe("checkpoint_idea");
    expect(task.context.referenceImagePath).toBeUndefined();
    expect(task.history.some((h) => /Reference image generation failed/.test(h.summary))).toBe(true);
  });

  it("captures a screenshot after verification passes when configured", async () => {
    const captureScreenshot = vi.fn().mockResolvedValue("/tmp/shot.png");
    const config = baseConfig({
      referenceImagePrompt: "a cyberpunk street",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      devCommand: "npm run dev",
      devUrl: "http://localhost:5173",
      generateImage: vi.fn(),
      captureScreenshot,
    });
    const task = createTask("Build a scene");
    task.stage = "verification";

    await advance(task, agents(), config);

    expect(captureScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ devCommand: "npm run dev", url: "http://localhost:5173", outPath: "/tmp/shot.png" }),
    );
    expect(task.context.implementationScreenshotPath).toBe("/tmp/shot.png");
    expect(task.stage).toBe("review_gemini");
  });

  it("degrades gracefully (and still advances) if the screenshot capture fails", async () => {
    const captureScreenshot = vi.fn().mockRejectedValue(new Error("dev server never came up"));
    const config = baseConfig({
      referenceImagePrompt: "a cyberpunk street",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      devCommand: "npm run dev",
      devUrl: "http://localhost:5173",
      generateImage: vi.fn(),
      captureScreenshot,
    });
    const task = createTask("Build a scene");
    task.stage = "verification";

    await advance(task, agents(), config);

    expect(task.stage).toBe("review_gemini");
    expect(task.context.implementationScreenshotPath).toBeUndefined();
    expect(task.history.some((h) => /Screenshot capture failed/.test(h.summary))).toBe(true);
  });
});

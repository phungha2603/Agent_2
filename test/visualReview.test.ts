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

describe("per-task project config isolation", () => {
  it("does not run the visual loop for a task whose own snapshot never set a reference image prompt, even if the live config currently has one (a later, unrelated project)", async () => {
    const generateImage = vi.fn().mockResolvedValue("/tmp/ref.png");
    const liveConfigForADifferentProject = baseConfig({
      referenceImagePrompt: "totally unrelated project's style",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      buildDir: "dist",
      generateImage,
      captureScreenshot: vi.fn(),
    });

    // This task was created (snapshotted) back when REFERENCE_IMAGE_PROMPT
    // was unset — it has its own projectConfig, just with no image prompt.
    const task = createTask("An unrelated backend task", {
      verifyCwd: liveConfigForADifferentProject.verify.cwd,
      verifyCommands: liveConfigForADifferentProject.verify.commands,
    });

    await advance(task, agents(), liveConfigForADifferentProject);

    expect(generateImage).not.toHaveBeenCalled();
    expect(task.context.referenceImagePath).toBeUndefined();
  });

  it("uses a task's own snapshotted prompt even if the live config's prompt has since changed", async () => {
    const generateImage = vi.fn().mockResolvedValue("/tmp/ref.png");
    const config = baseConfig({
      referenceImagePrompt: "a NEW project's style (set after this task was created)",
      referenceImagePath: "/tmp/new-ref.png",
      screenshotPath: "/tmp/new-shot.png",
      buildDir: "dist",
      generateImage,
      captureScreenshot: vi.fn(),
    });

    const task = createTask("The original UI task", {
      verifyCwd: config.verify.cwd,
      verifyCommands: config.verify.commands,
      referenceImagePrompt: "the original cyberpunk street prompt",
      referenceImagePath: "/tmp/original-ref.png",
    });

    await advance(task, agents(), config);

    expect(generateImage).toHaveBeenCalledWith("the original cyberpunk street prompt", "/tmp/original-ref.png");
    expect(task.context.referenceImagePath).toBe("/tmp/original-ref.png");
  });
});

describe("visual review hooks", () => {
  it("generates a reference image during ideation when configured", async () => {
    const generateImage = vi.fn().mockResolvedValue("/tmp/ref.png");
    const config = baseConfig({
      referenceImagePrompt: "a cyberpunk street",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      buildDir: "dist",
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
      buildDir: "dist",
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
      buildDir: "dist",
      generateImage,
      captureScreenshot: vi.fn(),
    });
    const task = createTask("Build a scene");

    await advance(task, agents(), config);

    expect(task.stage).toBe("checkpoint_idea");
    expect(task.context.referenceImagePath).toBeUndefined();
    expect(task.history.some((h) => /Reference image generation failed/.test(h.summary))).toBe(true);
  });

  it("also generates the reference image at architecture time if it wasn't made during ideation", async () => {
    const generateImage = vi.fn().mockResolvedValue("/tmp/ref.png");
    const config = baseConfig({
      referenceImagePrompt: "a cyberpunk street",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      buildDir: "dist",
      generateImage,
      captureScreenshot: vi.fn(),
    });
    const task = createTask("Build a scene");
    task.stage = "architecture"; // e.g. visual review turned on after ideation already ran

    await advance(task, agents(), config);

    expect(generateImage).toHaveBeenCalledWith("a cyberpunk street", "/tmp/ref.png");
    expect(task.context.referenceImagePath).toBe("/tmp/ref.png");
    expect(task.stage).toBe("implementation");
  });

  it("captures a screenshot after verification passes when configured", async () => {
    const captureScreenshot = vi.fn().mockResolvedValue("/tmp/shot.png");
    const config = baseConfig({
      referenceImagePrompt: "a cyberpunk street",
      referenceImagePath: "/tmp/ref.png",
      screenshotPath: "/tmp/shot.png",
      buildDir: "dist",
      generateImage: vi.fn(),
      captureScreenshot,
    });
    const task = createTask("Build a scene");
    task.stage = "verification";

    await advance(task, agents(), config);

    expect(captureScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ buildDir: "dist", outPath: "/tmp/shot.png" }),
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
      buildDir: "dist",
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

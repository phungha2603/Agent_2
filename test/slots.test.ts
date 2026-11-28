import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// slots.ts resolves data/dashboard.json from process.cwd() once, at module
// load time — so testing it against an isolated directory means chdir-ing
// *before* importing a fresh copy of the module, not just before calling
// its functions (that path would already be frozen from whatever cwd was
// in effect when some earlier test first imported it).
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
});

async function freshSlotsModule(cwd: string) {
  process.chdir(cwd);
  vi.resetModules();
  return import("../src/dashboard/slots.js");
}

function writeState(dir: string, content: string) {
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(path.join(dir, "data/dashboard.json"), content);
}

describe("loadDashboardState", () => {
  it("starts every slot with an empty queue when there's no file yet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slots-test-"));
    const { SLOTS, loadDashboardState } = await freshSlotsModule(dir);

    const state = await loadDashboardState();
    for (const slot of SLOTS) expect(state.slots[slot.id]).toEqual([]);
    expect(state.activePlanId).toBeNull();
  });

  it("round-trips a save through to a fresh load", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slots-test-"));
    const { SLOTS, loadDashboardState, saveDashboardState } = await freshSlotsModule(dir);

    const state = await loadDashboardState();
    state.slots[SLOTS[0].id].push("task-a", "task-b");
    state.activePlanId = "plan-1";
    await saveDashboardState(state);

    const reloaded = await loadDashboardState();
    expect(reloaded.slots[SLOTS[0].id]).toEqual(["task-a", "task-b"]);
    expect(reloaded.activePlanId).toBe("plan-1");
  });

  it("migrates the old one-task-per-slot file instead of dropping its assignments", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slots-test-"));
    writeState(dir, JSON.stringify({ "AG-03": "old-task", "AG-04": null }));
    const { loadDashboardState } = await freshSlotsModule(dir);

    const state = await loadDashboardState();
    expect(state.slots["AG-03"]).toEqual(["old-task"]);
    expect(state.slots["AG-04"]).toEqual([]);
    expect(state.activePlanId).toBeNull();
  });

  it("degrades to an empty state instead of crashing when the file is corrupted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slots-test-"));
    writeState(dir, ""); // e.g. a non-atomic write cut off mid-save
    const { SLOTS, loadDashboardState } = await freshSlotsModule(dir);

    const state = await loadDashboardState();
    for (const slot of SLOTS) expect(state.slots[slot.id]).toEqual([]);
  });
});

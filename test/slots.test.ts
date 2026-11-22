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

describe("loadDashboardState", () => {
  it("starts every slot unassigned when there's no file yet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slots-test-"));
    const { SLOTS, loadDashboardState } = await freshSlotsModule(dir);

    const state = await loadDashboardState();
    for (const slot of SLOTS) expect(state[slot.id]).toBeNull();
  });

  it("round-trips a save through to a fresh load", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slots-test-"));
    const { SLOTS, loadDashboardState, saveDashboardState } = await freshSlotsModule(dir);

    const state = await loadDashboardState();
    state[SLOTS[0].id] = "some-task-id";
    await saveDashboardState(state);

    const reloaded = await loadDashboardState();
    expect(reloaded[SLOTS[0].id]).toBe("some-task-id");
  });

  it("degrades to an empty state instead of crashing when the file is corrupted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slots-test-"));
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data/dashboard.json"), ""); // e.g. a non-atomic write cut off mid-save
    const { SLOTS, loadDashboardState } = await freshSlotsModule(dir);

    const state = await loadDashboardState();
    for (const slot of SLOTS) expect(state[slot.id]).toBeNull();
  });
});

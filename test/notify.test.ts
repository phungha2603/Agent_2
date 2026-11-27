import { describe, expect, it, vi } from "vitest";
import { createMacNotifier } from "../src/dashboard/notify.js";

describe("createMacNotifier", () => {
  it("is off outside macOS and with NOTIFY=0", () => {
    expect(createMacNotifier({ platform: "linux", env: {} })).toBeUndefined();
    expect(createMacNotifier({ platform: "darwin", env: { NOTIFY: "0" } })).toBeUndefined();
  });

  it("batches events that arrive together into one notification", () => {
    vi.useFakeTimers();
    const shown: [string, string][] = [];
    const notify = createMacNotifier({ platform: "darwin", env: {}, show: (t, b) => shown.push([t, b]) })!;
    notify("Chờ bạn duyệt", "AG-03 E1.S1");
    notify("Chờ bạn duyệt", "AG-04 E1.S2");
    expect(shown).toHaveLength(0);
    vi.advanceTimersByTime(4000);
    expect(shown).toEqual([["AI Company · 2 cập nhật", "Chờ bạn duyệt: AG-03 E1.S1 · Chờ bạn duyệt: AG-04 E1.S2"]]);
    notify("Kế hoạch hoàn tất", "goal");
    vi.advanceTimersByTime(4000);
    expect(shown[1]).toEqual(["AI Company · Kế hoạch hoàn tất", "goal"]);
    vi.useRealTimers();
  });
});

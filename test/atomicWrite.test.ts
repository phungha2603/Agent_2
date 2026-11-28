import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/store/atomicWrite.js";

describe("writeFileAtomic", () => {
  it("writes the full content and leaves no temp file behind", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atomic-write-test-"));
    const target = path.join(dir, "state.json");

    await writeFileAtomic(target, JSON.stringify({ hello: "world" }));

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ hello: "world" });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("replaces existing content atomically rather than appending or truncating in place", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atomic-write-test-"));
    const target = path.join(dir, "state.json");

    await writeFileAtomic(target, "a".repeat(1000));
    await writeFileAtomic(target, "short");

    expect(readFileSync(target, "utf8")).toBe("short");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

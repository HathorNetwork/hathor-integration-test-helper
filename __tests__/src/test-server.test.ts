import { describe, test, expect } from "bun:test";
import { buildTestPortCandidates } from "../../src/test-server";
import { config } from "../../src/config";

describe("buildTestPortCandidates", () => {
  test("always starts with port 0", () => {
    const candidates = buildTestPortCandidates(0, 5);
    expect(candidates[0]).toBe(0);
  });

  test("never includes production port", () => {
    const candidates = buildTestPortCandidates(2, 100);
    expect(candidates.includes(config.PORT)).toBe(false);
  });

  test("is deterministic for same worker id", () => {
    const a = buildTestPortCandidates(4, 8);
    const b = buildTestPortCandidates(4, 8);
    expect(a).toEqual(b);
  });
});


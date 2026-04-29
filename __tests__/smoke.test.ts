import { test, expect } from "bun:test";

test("toolchain smoke: bun + typescript run a trivial assertion", () => {
  expect(1 + 1).toBe(2);
});

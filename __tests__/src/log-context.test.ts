import { describe, test, expect } from "bun:test";
import { runWithTestName, getCurrentTestName } from "../../src/log-context";

describe("log-context", () => {
  test("getCurrentTestName returns undefined outside a context", () => {
    expect(getCurrentTestName()).toBeUndefined();
  });

  test("getCurrentTestName returns the bound name inside runWithTestName", () => {
    const result = runWithTestName("alpha", () => getCurrentTestName());
    expect(result).toBe("alpha");
  });

  test("propagates through awaited async boundary", async () => {
    const name = await runWithTestName("beta", async () => {
      await Promise.resolve();
      return getCurrentTestName();
    });
    expect(name).toBe("beta");
  });

  test("propagates through setTimeout callback", async () => {
    const captured = await runWithTestName("gamma", () => {
      return new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(getCurrentTestName()), 5);
      });
    });
    expect(captured).toBe("gamma");
  });

  test("nested contexts shadow then restore", () => {
    const outer = runWithTestName("outer", () => {
      const inner = runWithTestName("inner", () => getCurrentTestName());
      return { outer: getCurrentTestName(), inner };
    });
    expect(outer).toEqual({ outer: "outer", inner: "inner" });
    expect(getCurrentTestName()).toBeUndefined();
  });

  test("concurrent contexts do not leak", async () => {
    const [a, b] = await Promise.all([
      runWithTestName("ctx-a", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getCurrentTestName();
      }),
      runWithTestName("ctx-b", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getCurrentTestName();
      }),
    ]);
    expect(a).toBe("ctx-a");
    expect(b).toBe("ctx-b");
  });
});

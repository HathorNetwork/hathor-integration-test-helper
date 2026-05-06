import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { logger } from "../../src/logger";
import { runWithTestName } from "../../src/log-context";

type ConsoleMethod = "log" | "warn" | "error";

let captured: { method: ConsoleMethod; payload: Record<string, unknown> }[] = [];
let originals: Record<ConsoleMethod, (...args: unknown[]) => void>;

function captureConsole(method: ConsoleMethod) {
  return mock((line: unknown) => {
    captured.push({
      method,
      payload: JSON.parse(String(line)) as Record<string, unknown>,
    });
  });
}

beforeEach(() => {
  captured = [];
  originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = captureConsole("log");
  console.warn = captureConsole("warn");
  console.error = captureConsole("error");
});

afterEach(() => {
  console.log = originals.log;
  console.warn = originals.warn;
  console.error = originals.error;
});

describe("logger with X-Test-Name context", () => {
  test("does not include testName when called outside any context", () => {
    logger.info({ event: "outside.context" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload).not.toHaveProperty("testName");
  });

  test("includes testName when called inside runWithTestName", () => {
    runWithTestName("my-test", () => {
      logger.info({ event: "inside.context" });
    });
    expect(captured[0]!.payload.testName).toBe("my-test");
  });

  test("uses 'unknown' when context bound with literal 'unknown'", () => {
    runWithTestName("unknown", () => {
      logger.warn({ event: "inside.unknown" });
    });
    expect(captured[0]!.payload.testName).toBe("unknown");
    expect(captured[0]!.method).toBe("warn");
  });

  test("does not overwrite an explicit testName field on the payload", () => {
    runWithTestName("ctx", () => {
      logger.info({ event: "explicit", testName: "explicit-override" });
    });
    expect(captured[0]!.payload.testName).toBe("explicit-override");
  });

  test("propagates testName to logs emitted from setTimeout descendants", async () => {
    await runWithTestName("delayed", () => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          logger.info({ event: "deferred" });
          resolve();
        }, 5);
      });
    });
    expect(captured[0]!.payload.testName).toBe("delayed");
  });
});

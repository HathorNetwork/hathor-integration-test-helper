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

  test("renders BigInt values in meta as strings", () => {
    logger.info({ event: "fund", meta: { amount: 1000n } });
    expect(captured).toHaveLength(1);
    const meta = captured[0]!.payload.meta as Record<string, unknown>;
    expect(meta.amount).toBe("1000");
  });

  test("falls back to logger.serialization_failed on circular payload", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.info({ event: "x", meta: circular });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("error");
    expect(captured[0]!.payload.event).toBe("logger.serialization_failed");
    expect(captured[0]!.payload.originalEvent).toBe("x");
    expect(captured[0]!.payload.level).toBe("error");
    expect(typeof captured[0]!.payload.reason).toBe("string");
  });
});

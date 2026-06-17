import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  mock,
} from "bun:test";
import { createRoutes, withObservability } from "../../src/app";
import {
  initializeCache,
  __setGeneratorForTest,
  __resetCacheForTest,
} from "../../src/wallet.cache";
import {
  __resetMetricsForTest,
} from "../../src/metrics";
import type { SimpleWallet } from "../../src/wallet.service";

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

function stubWallet(): SimpleWallet {
  return {
    words: Array.from({ length: 24 }, (_, i) => `w${i}`).join(" "),
    addresses: Array.from({ length: 22 }, (_, i) => `addr-${i}`),
  };
}

beforeAll(() => {
  __resetCacheForTest();
  __setGeneratorForTest(stubWallet);
  initializeCache();
});

// bun:test runs all unit files in a single process, so module-level
// state (the wallet cache's generator binding, in particular) leaks
// across files. Restore the real generator after this suite to keep
// later tests order-independent.
afterAll(() => {
  __setGeneratorForTest(null);
  __resetCacheForTest();
});

beforeEach(() => {
  captured = [];
  __resetMetricsForTest();
  originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = captureConsole("log");
  console.warn = captureConsole("warn");
  console.error = captureConsole("error");
});

afterEach(() => {
  console.log = originals.log;
  console.warn = originals.warn;
  console.error = originals.error;
});

function findHttpRequestLog(route: string) {
  return captured.find((c) => {
    const meta = c.payload.meta as { route?: string } | undefined;
    return c.payload.event === "http.request" && meta?.route === route;
  });
}

describe("withObservability via createRoutes", () => {
  test("propagates X-Test-Name to http.request log", async () => {
    const handler = createRoutes()["/live"].GET;
    const res = await handler(
      new Request("http://x/live", {
        method: "GET",
        headers: { "x-test-name": "alpha" },
      }),
    );
    expect(res.status).toBe(200);
    const log = findHttpRequestLog("/live");
    expect(log).toBeDefined();
    expect(log!.payload.testName).toBe("alpha");
    expect(typeof log!.payload.requestId).toBe("string");
    const meta = log!.payload.meta as {
      method: string;
      status: number;
      latencyMs: number;
    };
    expect(meta.method).toBe("GET");
    expect(meta.status).toBe(200);
    expect(typeof meta.latencyMs).toBe("number");
  });

  test("defaults testName to 'unknown' when header missing", async () => {
    const handler = createRoutes()["/live"].GET;
    await handler(new Request("http://x/live", { method: "GET" }));
    const log = findHttpRequestLog("/live");
    expect(log?.payload.testName).toBe("unknown");
  });

  test("defaults testName to 'unknown' for whitespace-only header", async () => {
    const handler = createRoutes()["/live"].GET;
    await handler(
      new Request("http://x/live", {
        method: "GET",
        headers: { "x-test-name": "   " },
      }),
    );
    expect(findHttpRequestLog("/live")?.payload.testName).toBe("unknown");
  });

  test("echoes x-request-id when provided", async () => {
    const handler = createRoutes()["/live"].GET;
    const res = await handler(
      new Request("http://x/live", {
        method: "GET",
        headers: { "x-request-id": "abc-123" },
      }),
    );
    expect(res.headers.get("x-request-id")).toBe("abc-123");
  });

  test("mints x-request-id when absent", async () => {
    const handler = createRoutes()["/live"].GET;
    const res = await handler(new Request("http://x/live", { method: "GET" }));
    const id = res.headers.get("x-request-id");
    expect(id).toBeTypeOf("string");
    expect(id!.length).toBeGreaterThan(0);
  });
});

describe("withObservability error path", () => {
  test("uncaught throw → 500 INTERNAL_ERROR + http.unhandled_error log", async () => {
    const throwingHandler = withObservability("/boom", () => {
      throw new Error("boom!");
    });
    const res = await throwingHandler(
      new Request("http://x/boom", {
        method: "GET",
        headers: { "x-test-name": "fail-case" },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: string;
      message: string;
      retryable: boolean;
    };
    expect(body.error).toBe("INTERNAL_ERROR");
    expect(body.retryable).toBe(false);

    const errorLog = captured.find(
      (c) => c.payload.event === "http.unhandled_error",
    );
    expect(errorLog).toBeDefined();
    const errMeta = errorLog!.payload.meta as { route: string; error: string };
    expect(errMeta.route).toBe("/boom");
    expect(errMeta.error).toBe("boom!");
    expect(errorLog!.payload.testName).toBe("fail-case");

    // http.request log still emitted in the finally block.
    const reqLog = findHttpRequestLog("/boom");
    expect(reqLog).toBeDefined();
    const reqMeta = reqLog!.payload.meta as { status: number };
    expect(reqMeta.status).toBe(500);
  });

  test("testName binding crosses async boundaries inside the handler", async () => {
    const asyncHandler = withObservability("/async", async () => {
      // Force a microtask boundary so the next log line runs in a
      // continuation rather than the request frame.
      await Promise.resolve();
      const { logger } = await import("../../src/logger");
      logger.info({ event: "inside.async" });
      return new Response("ok");
    });
    await asyncHandler(
      new Request("http://x/async", {
        method: "GET",
        headers: { "x-test-name": "async-ctx" },
      }),
    );
    const inside = captured.find((c) => c.payload.event === "inside.async");
    expect(inside?.payload.testName).toBe("async-ctx");
  });
});

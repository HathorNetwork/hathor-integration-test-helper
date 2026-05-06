import { describe, test, expect } from "bun:test";
import { buildTestPortCandidates, startTestServer } from "../../src/test-server";
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

  test("does not emit duplicate ports when maxFallbacks > range", () => {
    // config.TEST_PORT_FALLBACK_SPAN defaults to 1000; asking for 10000
    // candidates would wrap and produce duplicates without the cap.
    const candidates = buildTestPortCandidates(0, 10_000);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test("rejects malformed JEST_WORKER_ID via inferWorkerId", () => {
    const orig = process.env.JEST_WORKER_ID;
    try {
      // parseInt("1x", 10) returns 1, which would offset every "1x"
      // worker onto the same range as a real worker 1. The regex guard
      // falls back to workerId=0 instead.
      process.env.JEST_WORKER_ID = "1x";
      const candidates = buildTestPortCandidates(undefined, 2);
      expect(candidates[1]).toBe(config.TEST_PORT_FALLBACK_START);
    } finally {
      if (orig === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = orig;
    }
  });
});

function eaddrinuse(): Error & { code: string } {
  const err = new Error("address in use") as Error & { code: string };
  err.code = "EADDRINUSE";
  return err;
}

type FakeServer = ReturnType<typeof Bun.serve>;
type FakeServeFn = (options: object) => FakeServer;
const baseOpts = { fetch: () => new Response("ok") } satisfies object;

describe("startTestServer", () => {
  test("returns the first server that succeeds", () => {
    const tried: number[] = [];
    const serveFn: FakeServeFn = (opts) => {
      const port = (opts as { port: number }).port;
      tried.push(port);
      return { port } as FakeServer;
    };

    const server = startTestServer(baseOpts, serveFn);
    expect(server.port).toBe(0);
    expect(tried).toEqual([0]);
  });

  test("retries on EADDRINUSE and returns once a port is free", () => {
    const tried: number[] = [];
    const serveFn: FakeServeFn = (opts) => {
      const port = (opts as { port: number }).port;
      tried.push(port);
      if (tried.length <= 2) throw eaddrinuse();
      return { port } as FakeServer;
    };

    const server = startTestServer(baseOpts, serveFn);
    expect(tried.length).toBe(3);
    expect(server.port).toBe(tried[2]);
  });

  test("rethrows non-EADDRINUSE errors immediately", () => {
    const tried: number[] = [];
    const serveFn: FakeServeFn = (opts) => {
      tried.push((opts as { port: number }).port);
      throw new TypeError("fetch handler is required");
    };

    expect(() => startTestServer(baseOpts, serveFn)).toThrow(TypeError);
    expect(tried).toEqual([0]);
  });

  test("after exhausting all candidates, throws the last EADDRINUSE with tried ports", () => {
    const tried: number[] = [];
    const serveFn: FakeServeFn = (opts) => {
      tried.push((opts as { port: number }).port);
      throw eaddrinuse();
    };

    let caught: (Error & { tried?: number[]; code?: string }) | undefined;
    try {
      startTestServer(baseOpts, serveFn);
    } catch (err) {
      caught = err as Error & { tried?: number[]; code?: string };
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe("EADDRINUSE");
    expect(caught!.tried?.length).toBe(tried.length);
    expect(tried.length).toBeGreaterThan(1);
  });
});


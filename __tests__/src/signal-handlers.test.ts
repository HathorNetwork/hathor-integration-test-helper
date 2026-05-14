import { describe, test, expect, mock } from "bun:test";
import { setupSignalHandlers } from "../../src/signal-handlers";

function makeProcessRef() {
  const handlers: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {};
  return {
    on(event: "SIGINT" | "SIGTERM", listener: () => void) {
      handlers[event] = listener;
    },
    fire(event: "SIGINT" | "SIGTERM") {
      handlers[event]?.();
    },
  };
}

function makeInstantTimeout(record: { delay: number }) {
  return ((fn: () => void, delay?: number) => {
    record.delay = delay ?? -1;
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
}

describe("setupSignalHandlers", () => {
  test("SIGINT triggers server.stop and exit(0) after drain", () => {
    const server = { stop: mock(() => {}) };
    const exit = mock(() => {});
    const processRef = makeProcessRef();
    const delay = { delay: -1 };

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: makeInstantTimeout(delay),
      exitRef: exit as unknown as (code?: number) => void,
    });
    processRef.fire("SIGINT");

    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(delay.delay).toBe(200);
  });

  test("SIGTERM behaves the same as SIGINT", () => {
    const server = { stop: mock(() => {}) };
    const exit = mock(() => {});
    const processRef = makeProcessRef();

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: makeInstantTimeout({ delay: -1 }),
      exitRef: exit as unknown as (code?: number) => void,
    });
    processRef.fire("SIGTERM");

    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("repeated signals collapse to one shutdown", () => {
    const server = { stop: mock(() => {}) };
    const exit = mock(() => {});
    const processRef = makeProcessRef();

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: makeInstantTimeout({ delay: -1 }),
      exitRef: exit as unknown as (code?: number) => void,
    });
    processRef.fire("SIGTERM");
    processRef.fire("SIGTERM");
    processRef.fire("SIGINT");

    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test("server.stop throwing routes to exit(1) and skips drain", () => {
    const server = {
      stop: mock(() => {
        throw new Error("stop failed");
      }),
    };
    const exit = mock(() => {});
    const processRef = makeProcessRef();
    let timeoutScheduled = false;
    const setTimeoutSpy = ((fn: () => void, _delay?: number) => {
      timeoutScheduled = true;
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: setTimeoutSpy,
      exitRef: exit as unknown as (code?: number) => void,
    });
    processRef.fire("SIGINT");

    expect(exit).toHaveBeenCalledWith(1);
    expect(timeoutScheduled).toBe(false);
  });

  test("shutdownDrainMs override is honoured", () => {
    const server = { stop: mock(() => {}) };
    const exit = mock(() => {});
    const processRef = makeProcessRef();
    const delay = { delay: -1 };

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: makeInstantTimeout(delay),
      exitRef: exit as unknown as (code?: number) => void,
      shutdownDrainMs: 50,
    });
    processRef.fire("SIGINT");

    expect(delay.delay).toBe(50);
  });
});

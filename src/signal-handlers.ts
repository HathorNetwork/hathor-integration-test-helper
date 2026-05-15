import { logger } from "./logger";

interface StoppableServer {
  // Bun's Server.stop() is async since Bun 1.2 — it resolves once
  // active connections have drained (or are forcibly closed). Awaiting
  // it lets the shutdown try/catch capture in-flight rejections and
  // prevents the drain delay from racing with an incomplete stop.
  stop: () => void | Promise<void>;
}

interface ProcessLike {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface SignalHandlerOptions {
  processRef?: ProcessLike;
  setTimeoutRef?: typeof setTimeout;
  exitRef?: (code?: number) => void;
  /**
   * Delay in milliseconds between calling `server.stop()` and
   * `process.exit(0)`, giving in-flight Bun.serve responses time to
   * drain before the process actually terminates. Default 200ms — long
   * enough for typical wallet-generation responses to flush, short
   * enough that container orchestrators don't escalate to SIGKILL.
   */
  shutdownDrainMs?: number;
}

/**
 * Register graceful SIGINT/SIGTERM handlers for `server`.
 *
 * All non-trivial dependencies (`process`, `setTimeout`, `process.exit`)
 * are injectable so the shutdown sequence can be exercised in tests
 * without actually killing the test runner.
 */
export function setupSignalHandlers(
  server: StoppableServer,
  options: SignalHandlerOptions = {},
) {
  const processRef = options.processRef ?? process;
  const setTimeoutRef = options.setTimeoutRef ?? setTimeout;
  const exitRef = options.exitRef ?? process.exit;
  const drainMs = options.shutdownDrainMs ?? 200;

  let shuttingDown = false;

  const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ event: "server.shutdown_requested", meta: { signal } });
    try {
      await server.stop();
    } catch (err) {
      logger.error({
        event: "server.shutdown_failed",
        meta: { signal, error: String(err) },
      });
      exitRef(1);
      return;
    }

    setTimeoutRef(() => {
      logger.info({ event: "server.stopped", meta: { signal } });
      exitRef(0);
    }, drainMs);
  };

  processRef.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  processRef.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  return { shutdown };
}

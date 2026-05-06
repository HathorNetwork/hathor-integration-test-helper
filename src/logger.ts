import { getCurrentTestName } from "./log-context";

/** Severity levels supported by the structured logger. */
type LogLevel = "info" | "warn" | "error";

/**
 * Structured log entry. Every entry must include an `event` name. Extra
 * structured fields go under `meta` rather than as top-level keys, so a
 * typo'd `TestName` cannot silently land alongside `testName`.
 */
export interface LogPayload {
  event: string;
  requestId?: string;
  testName?: string;
  meta?: Record<string, unknown>;
}

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

function write(level: LogLevel, payload: LogPayload): void {
  // Pull the X-Test-Name binding from AsyncLocalStorage so logs emitted
  // by background ops triggered from a request still carry the test name.
  // An explicit testName on the payload wins, matching the RFC's intent
  // that callers can override at the call site if needed.
  const testName = payload.testName ?? getCurrentTestName();
  const enriched: LogPayload =
    testName === undefined ? payload : { ...payload, testName };

  let entry: string;
  let serializationFailed = false;
  try {
    entry = JSON.stringify(
      { ts: new Date().toISOString(), level, ...enriched },
      jsonReplacer,
    );
  } catch (err) {
    serializationFailed = true;
    const reason = err instanceof Error ? err.message : String(err);
    try {
      entry = JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "logger.serialization_failed",
        originalEvent:
          typeof payload.event === "string" ? payload.event : "<non-string>",
        reason,
      });
    } catch {
      entry = `{"ts":"${new Date().toISOString()}","level":"error","event":"logger.serialization_failed"}`;
    }
  }

  // Serialization failures are always errors — route to stderr regardless
  // of the original log level so observability tools that watch stderr
  // see them.
  if (serializationFailed || level === "error") {
    console.error(entry);
    return;
  }
  if (level === "warn") {
    console.warn(entry);
    return;
  }
  console.log(entry);
}

/**
 * Structured JSON logger. Writes one JSON line per entry to stdout/stderr.
 * All entries include `ts` (ISO timestamp) and `level`.
 */
export const logger = {
  info(payload: LogPayload): void {
    write("info", payload);
  },
  warn(payload: LogPayload): void {
    write("warn", payload);
  },
  error(payload: LogPayload): void {
    write("error", payload);
  },
};

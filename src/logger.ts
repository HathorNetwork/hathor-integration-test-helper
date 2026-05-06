import { getCurrentTestName } from "./log-context";

/** Severity levels supported by the structured logger. */
type LogLevel = "info" | "warn" | "error";

/** Structured log entry. Every entry must include an `event` name. */
interface LogPayload {
  event: string;
  requestId?: string;
  testName?: string;
  [key: string]: unknown;
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
  try {
    entry = JSON.stringify(
      { ts: new Date().toISOString(), level, ...enriched },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
  } catch {
    entry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event: "logger.serialization_failed",
      originalEvent: payload.event,
    });
  }

  if (level === "error") {
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


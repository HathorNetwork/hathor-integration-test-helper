import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request log context. Carries the X-Test-Name header value (or
 * "unknown" when omitted) so the structured logger can include it on
 * every log line emitted while handling that request — including
 * background work scheduled via setTimeout / promise chains.
 *
 * AsyncLocalStorage is the right primitive here: passing the test name
 * through every function signature is impractical because background
 * splits and rescans triggered by `/fund` outlive the original request
 * frame yet conceptually still belong to it.
 */
interface LogContext {
  testName: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with `testName` bound as the current log context. Empty or
 * whitespace-only test names are coerced to "unknown" so the docstring's
 * promise holds at the boundary — callers don't need to defend against
 * a missing X-Test-Name header upstream.
 */
export function runWithTestName<T>(testName: string, fn: () => T): T {
  const trimmed = testName.trim();
  return storage.run({ testName: trimmed === "" ? "unknown" : trimmed }, fn);
}

/**
 * Return the test name bound to the active context, or undefined when
 * called outside any context (e.g. startup, module-load logs).
 */
export function getCurrentTestName(): string | undefined {
  return storage.getStore()?.testName;
}

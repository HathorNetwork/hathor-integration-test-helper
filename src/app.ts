import {
  handleSimpleWallet,
  handleMultisigWallet,
  handleStatus,
  handleReady,
  handleLive,
} from "./routes";
import { ensureRequestId, jsonError, withRequestIdHeader } from "./http";
import { logger } from "./logger";
import { recordHttpRequest } from "./metrics";
import { runWithTestName } from "./log-context";

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Wrap a route handler with the full observability pipeline:
 *
 * 1. Bind the X-Test-Name header into AsyncLocalStorage so every log
 *    line emitted inside the handler (including async continuations)
 *    carries `testName`.
 * 2. Resolve or mint an x-request-id and echo it on the response.
 * 3. Time the handler, accumulate per-route metrics, emit the
 *    `http.request` log line.
 * 4. Catch unexpected throws and surface them as `INTERNAL_ERROR` 500.
 *
 * The raw header value goes straight through to `runWithTestName` —
 * it handles trim/`"unknown"`-default once at the boundary.
 */
export function withObservability(route: string, handler: Handler): Handler {
  return (req: Request) => {
    const rawTestName = req.headers.get("x-test-name") ?? "";
    return runWithTestName(rawTestName, () => runHandler(route, req, handler));
  };
}

async function runHandler(
  route: string,
  req: Request,
  handler: Handler,
): Promise<Response> {
  const requestId = ensureRequestId(req);
  const startedAt = performance.now();
  let status = 500;
  let res: Response;

  try {
    res = await handler(req);
    status = res.status;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({
      event: "http.unhandled_error",
      requestId,
      meta: { route, error: message },
    });
    res = jsonError(500, "INTERNAL_ERROR", "Internal Server Error", false);
    status = 500;
  } finally {
    const latencyMs = Number((performance.now() - startedAt).toFixed(2));
    recordHttpRequest(route, status, latencyMs);
    logger.info({
      event: "http.request",
      requestId,
      meta: { route, method: req.method, status, latencyMs },
    });
  }
  return withRequestIdHeader(res, requestId);
}

/**
 * Build the Bun.serve route table. The `/fund` and `/metrics` endpoints
 * are added by the funding PRs; the genesis/readiness layer registers
 * `/status` and `/ready` here alongside the wallet endpoints.
 */
export function createRoutes() {
  return {
    "/simpleWallet": {
      GET: withObservability("/simpleWallet", handleSimpleWallet),
    },
    "/multisigWallet": {
      GET: withObservability("/multisigWallet", handleMultisigWallet),
    },
    "/status": {
      GET: withObservability("/status", handleStatus),
    },
    "/ready": {
      GET: withObservability("/ready", handleReady),
    },
    "/live": {
      GET: withObservability("/live", handleLive),
    },
  };
}

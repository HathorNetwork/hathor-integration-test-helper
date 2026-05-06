import type { ErrorCode, ServiceError } from "./errors";

/**
 * Standard error body, as defined by the RFC's "Error response schema":
 *
 *   { error: <machine-readable code>, message: <human text>, retryable: bool }
 *
 * `error` carries the code (e.g. "POOL_EXHAUSTED"); `message` is the
 * human-readable description; `retryable` tells the client whether
 * automatic retry with backoff is appropriate.
 */
export interface ApiErrorBody {
  error: string;
  message: string;
  retryable: boolean;
}

/** Build a JSON error Response with the given status, code, message, and retryable flag. */
export function jsonError(
  status: number,
  code: ErrorCode | string,
  message: string,
  retryable: boolean,
): Response {
  const body: ApiErrorBody = { error: code, message, retryable };
  return Response.json(body, { status });
}

/** Convenience: convert a {@link ServiceError} into the RFC error response. */
export function jsonErrorFromService(err: ServiceError): Response {
  const { code, status, retryable } = err.descriptor;
  return jsonError(status, code, err.message, retryable);
}

/** Extract the x-request-id header from the request, or generate a UUID if absent. */
export function ensureRequestId(req: Request): string {
  const incoming = req.headers.get("x-request-id");
  if (incoming && incoming.trim() !== "") {
    return incoming.trim();
  }
  return crypto.randomUUID();
}

/** Clone a Response with the x-request-id header set for tracing. */
export function withRequestIdHeader(res: Response, requestId: string): Response {
  const headers = new Headers(res.headers);
  headers.set("x-request-id", requestId);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

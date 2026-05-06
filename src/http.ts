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
  readonly error: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~+/=:-]{1,128}$/;

/**
 * Build a JSON error Response with the given status, code, message, and
 * retryable flag. The HTTP status is constrained to a 4xx/5xx integer
 * so the wire-format error body never accompanies a 2xx/3xx status by
 * accident.
 *
 * @throws RangeError if status is not an integer in [400, 599].
 */
export function jsonError(
  status: number,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): Response {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError(`jsonError status must be a 4xx/5xx integer, got ${status}`);
  }
  const body: ApiErrorBody = { error: code, message, retryable };
  return Response.json(body, { status });
}

/** Convenience: convert a {@link ServiceError} into the RFC error response. */
export function jsonErrorFromService(err: ServiceError): Response {
  const { code, status, retryable } = err.descriptor;
  return jsonError(status, code, err.message, retryable);
}

/**
 * Extract a tracing-safe x-request-id header from the request, or
 * generate a UUID when absent or malformed. The accepted shape is the
 * conservative subset of [A-Za-z0-9._~+/=:-]{1,128}, which covers UUIDs,
 * URL-safe base64, and standard tracing IDs while rejecting control
 * characters, header-injection bytes, and 10kB blobs.
 */
export function ensureRequestId(req: Request): string {
  const incoming = req.headers.get("x-request-id")?.trim();
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) {
    return incoming;
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

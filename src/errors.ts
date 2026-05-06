/**
 * Typed error hierarchy aligned with the RFC's "Error response schema"
 * section. Each subclass carries a {@link ErrorDescriptor} so the HTTP
 * layer can map it to a body of `{error, message, retryable}` and an
 * appropriate status code without resorting to message-substring checks.
 */

export type ErrorCode =
  | "POOL_EXHAUSTED"
  | "SPLIT_IN_PROGRESS"
  | "UTXO_STALE"
  | "FUND_TIMEOUT"
  | "INVALID_REQUEST"
  | "SERVICE_NOT_READY";

/** HTTP-facing metadata describing a known service-level failure. */
export interface ErrorDescriptor {
  code: ErrorCode;
  status: number;
  retryable: boolean;
}

/** Base class for any failure intended to surface as a structured RFC error. */
export class ServiceError extends Error {
  constructor(
    public readonly descriptor: ErrorDescriptor,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

export class PoolExhaustedError extends ServiceError {
  constructor(message = "No UTXOs available for the requested amount") {
    super({ code: "POOL_EXHAUSTED", status: 409, retryable: true }, message);
  }
}

export class FundTimeoutError extends ServiceError {
  constructor(timeoutMs: number) {
    super(
      { code: "FUND_TIMEOUT", status: 409, retryable: true },
      `Timed out waiting for a large UTXO (${timeoutMs}ms)`,
    );
  }
}

export class SplitInProgressError extends ServiceError {
  constructor(
    message = "UTXO split is in progress; pool will refill shortly",
  ) {
    super({ code: "SPLIT_IN_PROGRESS", status: 409, retryable: true }, message);
  }
}

export class UtxoStaleError extends ServiceError {
  constructor(
    message = "Reserved UTXO was already spent; rescan triggered",
    options?: { cause?: unknown },
  ) {
    super({ code: "UTXO_STALE", status: 409, retryable: true }, message, options);
  }
}

export class ServiceNotReadyError extends ServiceError {
  constructor(message = "Genesis wallet not yet initialized") {
    super({ code: "SERVICE_NOT_READY", status: 503, retryable: true }, message);
  }
}

export class InvalidRequestError extends ServiceError {
  constructor(message: string) {
    super({ code: "INVALID_REQUEST", status: 400, retryable: false }, message);
  }
}

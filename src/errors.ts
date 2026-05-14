/**
 * Typed error hierarchy aligned with the RFC's "Error response schema"
 * section. Each ServiceError carries a {@link ErrorDescriptor} so the HTTP
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

/**
 * Single source of truth pinning each ErrorCode to its HTTP status and
 * retryable flag. The `satisfies Record<ErrorCode, ...>` clause makes
 * adding a new ErrorCode without a row a compile error — closing the
 * loop with the union and preventing wire-contract drift between the
 * subclasses and the RFC.
 */
const ERROR_TABLE = {
  POOL_EXHAUSTED:    { status: 409, retryable: true  },
  SPLIT_IN_PROGRESS: { status: 409, retryable: true  },
  UTXO_STALE:        { status: 409, retryable: true  },
  FUND_TIMEOUT:      { status: 409, retryable: true  },
  SERVICE_NOT_READY: { status: 503, retryable: true  },
  INVALID_REQUEST:   { status: 400, retryable: false },
} as const satisfies Record<ErrorCode, { status: number; retryable: boolean }>;

/** HTTP-facing metadata describing a known service-level failure. */
export interface ErrorDescriptor {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
}

/** Base class for any failure intended to surface as a structured RFC error. */
export class ServiceError extends Error {
  public readonly descriptor: ErrorDescriptor;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.descriptor = { code, ...ERROR_TABLE[code] };
    this.name = new.target.name;
  }
}

export class PoolExhaustedError extends ServiceError {
  constructor(message = "No UTXOs available for the requested amount") {
    super("POOL_EXHAUSTED", message);
  }
}

export class FundTimeoutError extends ServiceError {
  constructor(timeoutMs: number) {
    super("FUND_TIMEOUT", `Timed out waiting for a large UTXO (${timeoutMs}ms)`);
  }
}

export class SplitInProgressError extends ServiceError {
  constructor(message = "UTXO split is in progress; pool will refill shortly") {
    super("SPLIT_IN_PROGRESS", message);
  }
}

export class UtxoStaleError extends ServiceError {
  constructor(
    message = "Reserved UTXO was already spent; rescan triggered",
    options?: ErrorOptions,
  ) {
    super("UTXO_STALE", message, options);
  }
}

export class ServiceNotReadyError extends ServiceError {
  constructor(message = "Genesis wallet not yet initialized") {
    super("SERVICE_NOT_READY", message);
  }
}

export class InvalidRequestError extends ServiceError {
  constructor(message: string) {
    super("INVALID_REQUEST", message);
  }
}

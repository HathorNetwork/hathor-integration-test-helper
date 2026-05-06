import { describe, test, expect } from "bun:test";
import {
  ServiceError,
  PoolExhaustedError,
  FundTimeoutError,
  SplitInProgressError,
  UtxoStaleError,
  ServiceNotReadyError,
  InvalidRequestError,
} from "../../src/errors";

describe("ServiceError taxonomy", () => {
  test("PoolExhaustedError descriptor matches RFC", () => {
    const err = new PoolExhaustedError();
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toBeInstanceOf(Error);
    expect(err.descriptor).toEqual({
      code: "POOL_EXHAUSTED",
      status: 409,
      retryable: true,
    });
    expect(err.message).toMatch(/UTXO/i);
  });

  test("FundTimeoutError descriptor matches RFC", () => {
    const err = new FundTimeoutError(30000);
    expect(err.descriptor).toEqual({
      code: "FUND_TIMEOUT",
      status: 409,
      retryable: true,
    });
    expect(err.message).toContain("30000");
  });

  test("SplitInProgressError descriptor matches RFC", () => {
    const err = new SplitInProgressError();
    expect(err.descriptor).toEqual({
      code: "SPLIT_IN_PROGRESS",
      status: 409,
      retryable: true,
    });
  });

  test("UtxoStaleError descriptor matches RFC", () => {
    const err = new UtxoStaleError();
    expect(err.descriptor).toEqual({
      code: "UTXO_STALE",
      status: 409,
      retryable: true,
    });
  });

  test("ServiceNotReadyError descriptor matches RFC", () => {
    const err = new ServiceNotReadyError();
    expect(err.descriptor).toEqual({
      code: "SERVICE_NOT_READY",
      status: 503,
      retryable: true,
    });
  });

  test("InvalidRequestError descriptor matches RFC", () => {
    const err = new InvalidRequestError("bad address");
    expect(err.descriptor).toEqual({
      code: "INVALID_REQUEST",
      status: 400,
      retryable: false,
    });
    expect(err.message).toBe("bad address");
  });

  test("ServiceError has a stable name for instance checks across modules", () => {
    expect(new PoolExhaustedError().name).toBe("PoolExhaustedError");
    expect(new UtxoStaleError().name).toBe("UtxoStaleError");
  });

  test("ServiceError preserves cause when provided", () => {
    const cause = new Error("underlying");
    const err = new UtxoStaleError("stale", { cause });
    expect(err.cause).toBe(cause);
  });
});

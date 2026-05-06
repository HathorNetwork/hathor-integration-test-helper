import { describe, test, expect } from "bun:test";
import { jsonError, jsonErrorFromService } from "../../src/http";
import { PoolExhaustedError, InvalidRequestError } from "../../src/errors";

describe("jsonError emits the RFC body shape", () => {
  test("body has exactly {error, message, retryable}", async () => {
    const res = jsonError(409, "POOL_EXHAUSTED", "exhausted", true);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "POOL_EXHAUSTED",
      message: "exhausted",
      retryable: true,
    });
  });

  test("non-retryable errors set retryable: false", async () => {
    const res = jsonError(400, "INVALID_REQUEST", "bad", false);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("details");
  });

  test("Content-Type is application/json", () => {
    const res = jsonError(503, "SERVICE_NOT_READY", "not ready", true);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("jsonErrorFromService maps a ServiceError to a Response", () => {
  test("PoolExhaustedError → {error:'POOL_EXHAUSTED', retryable:true, status:409}", async () => {
    const res = jsonErrorFromService(new PoolExhaustedError("nope"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "POOL_EXHAUSTED",
      message: "nope",
      retryable: true,
    });
  });

  test("InvalidRequestError → {error:'INVALID_REQUEST', retryable:false, status:400}", async () => {
    const res = jsonErrorFromService(new InvalidRequestError("missing field"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: "INVALID_REQUEST",
      message: "missing field",
      retryable: false,
    });
  });
});

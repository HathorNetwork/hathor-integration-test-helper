import { describe, test, expect } from "bun:test";
import {
  jsonError,
  jsonErrorFromService,
  ensureRequestId,
  withRequestIdHeader,
} from "../../src/http";
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

describe("jsonError rejects non-error statuses", () => {
  test("throws on 2xx", () => {
    expect(() => jsonError(200, "POOL_EXHAUSTED", "x", true)).toThrow(RangeError);
  });

  test("throws on 3xx", () => {
    expect(() => jsonError(302, "POOL_EXHAUSTED", "x", true)).toThrow(RangeError);
  });

  test("throws on out-of-range numbers", () => {
    expect(() => jsonError(700, "POOL_EXHAUSTED", "x", true)).toThrow(RangeError);
    expect(() => jsonError(NaN, "POOL_EXHAUSTED", "x", true)).toThrow(RangeError);
    expect(() => jsonError(409.5, "POOL_EXHAUSTED", "x", true)).toThrow(RangeError);
  });
});

describe("ensureRequestId", () => {
  test("returns the trimmed inbound header when well-formed", () => {
    const req = new Request("http://x/", {
      headers: { "x-request-id": "  abc-123  " },
    });
    expect(ensureRequestId(req)).toBe("abc-123");
  });

  test("returns a fresh UUID when the header is absent", () => {
    const req = new Request("http://x/");
    const id = ensureRequestId(req);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("returns a fresh UUID when the header is empty / whitespace", () => {
    const r1 = new Request("http://x/", { headers: { "x-request-id": "" } });
    const r2 = new Request("http://x/", { headers: { "x-request-id": "   " } });
    expect(ensureRequestId(r1)).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureRequestId(r2)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("rejects malformed (control chars / oversized) and falls through to UUID", () => {
    const oversized = "a".repeat(200);
    const r1 = new Request("http://x/", { headers: { "x-request-id": oversized } });
    const r2 = new Request("http://x/", { headers: { "x-request-id": "with space" } });
    expect(ensureRequestId(r1)).not.toBe(oversized);
    expect(ensureRequestId(r1)).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureRequestId(r2)).not.toBe("with space");
  });
});

describe("withRequestIdHeader", () => {
  test("sets the x-request-id header without changing status or body", async () => {
    const original = Response.json({ ok: true }, { status: 200 });
    const wrapped = withRequestIdHeader(original, "req-1");
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("x-request-id")).toBe("req-1");
    expect(await wrapped.json()).toEqual({ ok: true });
  });
});

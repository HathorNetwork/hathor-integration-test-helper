import { describe, test, expect } from "bun:test";
import { handleNotFound } from "../../src/app";

/**
 * Bun's method-keyed route objects do not emit 405 — a known path called with
 * an undefined method simply falls through to the server's `fetch` handler,
 * exactly like an unknown path. Without a fallback both cases answer with Bun's
 * bare bodyless 404, which contradicts the RFC's promise that every failure
 * carries `{error, message, retryable}`.
 */
function request(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("unmatched routes carry the RFC error envelope", () => {
  test("an unknown path answers 404 with the standard body", async () => {
    const res = await handleNotFound(request("GET", "/nope"));

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      error: string;
      message: string;
      retryable: boolean;
    };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
    expect(body.message).toContain("/nope");
  });

  test.each([
    ["GET", "/fund"],
    ["PUT", "/fund"],
    ["POST", "/metrics"],
    ["HEAD", "/metrics"],
  ])("%s %s falls through with the envelope, not a bare 404", async (method, path) => {
    const res = await handleNotFound(request(method, path));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.message).toContain(method);
    expect(body.message).toContain(path);
  });

  test("the response carries a request id like every other route", async () => {
    const res = await handleNotFound(request("GET", "/nope"));
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

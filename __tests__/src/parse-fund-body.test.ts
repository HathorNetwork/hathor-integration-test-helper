import { describe, test, expect } from "bun:test";
import { parseFundBody } from "../../src/parse-fund-body";
import { config } from "../../src/config";
import { generateSimpleWallet } from "../../src/wallet.service";

const validAddress = generateSimpleWallet().addresses[0]!;

function fundReq(body: string, contentType = "application/json"): Request {
  return new Request("http://localhost/fund", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

describe("parseFundBody", () => {
  test("valid request with address only uses default amount", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: validAddress })),
    );
    expect(isResponse(result)).toBe(false);
    if (isResponse(result)) return;

    expect(result.address).toBe(validAddress);
    expect(result.amount).toBe(config.UTXO_SPLIT_AMOUNT);
  });

  test("trims whitespace from address", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: `  ${validAddress}  ` })),
    );
    expect(isResponse(result)).toBe(false);
    if (isResponse(result)) return;

    expect(result.address).toBe(validAddress);
  });

  test("returns 400 when address is missing", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ amount: 100 })),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;
    expect(result.status).toBe(400);

    const body = await result.json() as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });

  test("returns 400 when address is invalid", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: "WInvalidAddress", amount: 100 })),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;
    expect(result.status).toBe(400);

    const body = await result.json() as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });

  test("accepts numeric integer amount", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: validAddress, amount: 500 })),
    );
    expect(isResponse(result)).toBe(false);
    if (isResponse(result)) return;
    expect(result.amount).toBe(500n);
  });

  test("returns 400 for unsafe integer numeric amount", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: validAddress, amount: Number.MAX_SAFE_INTEGER + 1 })),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;

    expect(result.status).toBe(400);
    const body = await result.json() as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });

  test("accepts string integer amount", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: validAddress, amount: "750" })),
    );
    expect(isResponse(result)).toBe(false);
    if (isResponse(result)) return;
    expect(result.amount).toBe(750n);
  });

  test("returns 400 for scientific notation string amount", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: validAddress, amount: "1e4" })),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;
    expect(result.status).toBe(400);
  });

  test("returns 400 for decimal string amount", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: validAddress, amount: "100.5" })),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;
    expect(result.status).toBe(400);
  });

  test("returns 400 for invalid content type", async () => {
    const result = await parseFundBody(
      fundReq(JSON.stringify({ address: validAddress }), "text/plain"),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;
    expect(result.status).toBe(400);

    const body = await result.json() as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });

  test("returns 413 for oversized body", async () => {
    const oversized = "x".repeat(config.MAX_REQUEST_BODY_BYTES + 1);
    const result = await parseFundBody(
      fundReq(`{"address":"${validAddress}","amount":"1","extra":"${oversized}"}`),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;
    expect(result.status).toBe(413);
  });

  test("returns 400 for invalid JSON body", async () => {
    const result = await parseFundBody(
      fundReq("not json at all"),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;

    expect(result.status).toBe(400);
    const body = await result.json() as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });

  test("returns 413 INVALID_REQUEST shape for oversized body", async () => {
    const oversized = "x".repeat(config.MAX_REQUEST_BODY_BYTES + 1);
    const result = await parseFundBody(
      fundReq(`{"address":"${validAddress}","amount":"1","extra":"${oversized}"}`),
    );
    expect(isResponse(result)).toBe(true);
    if (!isResponse(result)) return;
    expect(result.status).toBe(413);
    const body = await result.json() as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });
});

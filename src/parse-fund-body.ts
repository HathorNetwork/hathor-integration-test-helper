import { config } from "./config";
import { isValidHathorAddress } from "./address";
import { jsonErrorFromCode } from "./http";

/**
 * Successful result of parsing a /fund request body.
 */
export interface ParsedFundBody {
  address: string;
  amount: bigint;
}

function invalid(message: string, status = 400): Response {
  // The RFC defines a single INVALID_REQUEST code for malformed input, but the
  // status varies: 400 for bad fields, 413 for an oversized body. That is why
  // this builds the response from the code rather than going through
  // InvalidRequestError/jsonErrorFromService — INVALID_REQUEST is pinned to 400
  // by its descriptor, so that path structurally cannot emit the 413.
  // `retryable` still comes from the error table either way.
  return jsonErrorFromCode("INVALID_REQUEST", message, status);
}

/**
 * Parse and validate the JSON body of a POST /fund request.
 *
 * Returns either a {@link ParsedFundBody} on success or an error
 * `Response` (status 400 / 413) following the RFC's error shape.
 *
 * Rules:
 * - `address` is required, must be a non-empty string (whitespace-trimmed).
 *   It must also be a valid Hathor address for the configured network.
 * - `amount`:
 *   - undefined/null -> default `config.UTXO_SPLIT_AMOUNT`
 *   - number -> must be finite, positive, integer, and safe JS integer
 *   - string -> must be digits only (no exponent/decimal notation)
 *   - anything else -> 400
 */
export async function parseFundBody(
  req: Request,
): Promise<ParsedFundBody | Response> {
  const contentType = req.headers.get("content-type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return invalid("content-type must be application/json");
  }

  const tooLarge = () =>
    invalid(`Request body exceeds ${config.MAX_REQUEST_BODY_BYTES} bytes`, 413);

  // Check the declared size *before* reading. `req.text()` buffers the whole
  // body into memory first, so a check that only ran afterwards would reject
  // the request without protecting the process against it.
  const declaredSize = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > config.MAX_REQUEST_BODY_BYTES) {
    return tooLarge();
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return invalid("Invalid JSON body");
  }

  // Re-check the real size: content-length is absent under chunked transfer
  // encoding and is client-supplied in any case. Measured with
  // Buffer.byteLength rather than TextEncoder().encode().length, which would
  // allocate a second full copy of the body purely to count its bytes.
  if (Buffer.byteLength(rawBody, "utf8") > config.MAX_REQUEST_BODY_BYTES) {
    return tooLarge();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return invalid("Invalid JSON body");
  }

  // Reject null, arrays, and primitives before destructuring. Only `null` would
  // actually throw on destructuring (`const { address } = 5` is legal and just
  // yields undefined) — surfacing as a 500 instead of the RFC's 400. Arrays and
  // primitives are rejected here for a different reason: they would otherwise
  // fall through to the generic "address is required" message, when "body must
  // be a JSON object" names the real problem.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("body must be a JSON object");
  }

  const { address, amount: rawAmount } = parsed as {
    address?: unknown;
    amount?: unknown;
  };

  if (!address || typeof address !== "string" || address.trim() === "") {
    return invalid("address is required and must be a non-empty string");
  }

  const normalizedAddress = address.trim();
  if (!isValidHathorAddress(normalizedAddress)) {
    return invalid(
      "address must be a valid Hathor address for the configured network",
    );
  }

  let amount: bigint;
  if (rawAmount === undefined || rawAmount === null) {
    amount = config.UTXO_SPLIT_AMOUNT;
  } else if (typeof rawAmount === "number") {
    if (!Number.isFinite(rawAmount) || !Number.isInteger(rawAmount) || rawAmount <= 0) {
      return invalid("amount must be a positive integer");
    }
    if (!Number.isSafeInteger(rawAmount)) {
      return invalid(
        "amount is outside the safe integer range; send it as a digit-only string",
      );
    }
    amount = BigInt(rawAmount);
  } else if (typeof rawAmount === "string") {
    const normalizedAmount = rawAmount.trim();
    if (!/^[0-9]+$/.test(normalizedAmount)) {
      return invalid("amount must be a positive integer");
    }
    amount = BigInt(normalizedAmount);
    if (amount <= 0n) {
      return invalid("amount must be a positive integer");
    }
  } else {
    return invalid("amount must be a positive integer");
  }

  return { address: normalizedAddress, amount };
}

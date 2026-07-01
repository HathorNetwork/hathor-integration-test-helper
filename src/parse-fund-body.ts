import { config } from "./config";
import { isValidHathorAddress } from "./address";
import { jsonErrorFromService } from "./http";
import { InvalidRequestError } from "./errors";

/**
 * Successful result of parsing a /fund request body.
 */
export interface ParsedFundBody {
  address: string;
  amount: bigint;
}

function invalid(message: string, status = 400): Response {
  // The RFC defines a single INVALID_REQUEST code for malformed input.
  // Status varies (400 for bad fields; 413 for oversized body) but the
  // body shape is uniform: { error: "INVALID_REQUEST", message, retryable: false }.
  const res = jsonErrorFromService(new InvalidRequestError(message));
  if (status === 400) return res;
  return new Response(res.body, {
    status,
    statusText: res.statusText,
    headers: res.headers,
  });
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

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return invalid("Invalid JSON body");
  }

  const bodySize = new TextEncoder().encode(rawBody).length;
  if (bodySize > config.MAX_REQUEST_BODY_BYTES) {
    return invalid(
      `Request body exceeds ${config.MAX_REQUEST_BODY_BYTES} bytes`,
      413,
    );
  }

  let body: { address?: unknown; amount?: unknown };
  try {
    body = JSON.parse(rawBody) as { address?: unknown; amount?: unknown };
  } catch {
    return invalid("Invalid JSON body");
  }

  const { address, amount: rawAmount } = body;

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

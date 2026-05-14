import { getSimpleWalletFromCache } from "./wallet.cache";
import { generateMultisigWallet } from "./wallet.service";
import { jsonErrorFromService } from "./http";
import { InvalidRequestError } from "./errors";

/**
 * Route handlers for PR2. Each handler returns a `Response` — including
 * for *expected* error conditions (the `withObservability` wrapper's
 * catch is reserved for truly unexpected throws). Caller-facing errors
 * are surfaced via `jsonErrorFromService` so the `{error, message,
 * retryable}` body shape stays consistent across the API.
 *
 * `genTime` is measured per request and included in the success body so
 * client-side test harnesses can attribute generation cost without
 * scraping logs.
 */

function nowMs(): number {
  return performance.now();
}

function elapsed(start: number): number {
  return Number((nowMs() - start).toFixed(2));
}

/** GET /simpleWallet — pop a pre-generated wallet from the cache. */
export function handleSimpleWallet(_req: Request): Response {
  const start = nowMs();
  const wallet = getSimpleWalletFromCache();
  return Response.json({ ...wallet, genTime: elapsed(start) });
}

/**
 * GET /multisigWallet?participants=N&numSignatures=M
 *
 * Validates the two query params (presence, integer, positivity,
 * `numSignatures <= participants`) before delegating to the generator.
 * No upper bound on `participants`: callers wanting an unusually large
 * multisig pay the synchronous seed-generation cost themselves.
 */
export function handleMultisigWallet(req: Request): Response {
  const start = nowMs();
  const url = new URL(req.url);
  const participantsParam = url.searchParams.get("participants");
  const numSignaturesParam = url.searchParams.get("numSignatures");

  if (!participantsParam || !numSignaturesParam) {
    return jsonErrorFromService(
      new InvalidRequestError(
        "Missing required query parameters: participants and numSignatures",
      ),
    );
  }

  const participants = Number.parseInt(participantsParam, 10);
  const numSignatures = Number.parseInt(numSignaturesParam, 10);

  if (Number.isNaN(participants) || Number.isNaN(numSignatures)) {
    return jsonErrorFromService(
      new InvalidRequestError(
        "participants and numSignatures must be valid integers",
      ),
    );
  }

  if (participants < 1) {
    return jsonErrorFromService(
      new InvalidRequestError("participants must be >= 1"),
    );
  }

  if (numSignatures < 1) {
    return jsonErrorFromService(
      new InvalidRequestError("numSignatures must be >= 1"),
    );
  }

  if (numSignatures > participants) {
    return jsonErrorFromService(
      new InvalidRequestError("numSignatures must be <= participants"),
    );
  }

  const wallets = generateMultisigWallet(participants, numSignatures);
  return Response.json({ wallets, genTime: elapsed(start) });
}

/** GET /live — liveness probe. Always 200; readiness lives at /ready (PR3). */
export function handleLive(_req: Request): Response {
  return Response.json({ live: true });
}

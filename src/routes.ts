import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";
import { getSimpleWalletFromCache } from "./wallet.cache";
import { generateMultisigWallet } from "./wallet.service";
import { isGenesisReady, getGenesisAddress } from "./genesis.service";
import { getPoolStats, type PoolStats } from "./utxo-pool.service";
import { parseFundBody } from "./parse-fund-body";
import { fundAddress, getFundingLifecycleState } from "./fund.service";
import { getStartupState } from "./startup";
import { config } from "./config";
import { jsonError, jsonErrorFromService } from "./http";
import { logger } from "./logger";
import { getMetricsSnapshot, recordFundSuccess } from "./metrics";
import { InvalidRequestError, ServiceError, ServiceNotReadyError } from "./errors";

/**
 * Route handlers for PR2. Each handler returns a `Response` — including
 * for *expected* error conditions (the `withObservability` wrapper's
 * catch is reserved for truly unexpected throws). Caller-facing errors
 * are surfaced via `jsonErrorFromService` so the `{error, message,
 * retryable}` body shape stays consistent across the API.
 *
 * `retrieveTimeMs` is measured per request and included in the success
 * body so client-side test harnesses can attribute the cost of obtaining
 * a wallet without scraping logs. On the warm cache path this measures
 * retrieval (~0ms); the real BIP39 derivation cost only surfaces on the
 * synchronous empty-cache fallback — hence "retrieve", not "generate".
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
  return Response.json({ ...wallet, retrieveTimeMs: elapsed(start) });
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

  // Strict integer match: parseInt would silently accept "2abc" or "1.5"
  // (truncating to 2 and 1 respectively), which lets garbage flow into
  // generateMultisigWallet. Require the whole string to be digits before
  // parsing — same pattern test-server.ts uses for worker-id validation.
  const intPattern = /^\d+$/;
  if (
    !intPattern.test(participantsParam) ||
    !intPattern.test(numSignaturesParam)
  ) {
    return jsonErrorFromService(
      new InvalidRequestError(
        "participants and numSignatures must be valid integers",
      ),
    );
  }

  const participants = Number(participantsParam);
  const numSignatures = Number(numSignaturesParam);

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
  return Response.json({ wallets, retrieveTimeMs: elapsed(start) });
}

/** Machine-readable readiness reasons surfaced by /ready and /status. */
export type ReadyReason =
  | "funding_disabled"
  | "genesis_wallet_not_ready"
  | "utxo_pool_empty"
  | "ready";

export interface ReadinessVerdict {
  readonly ready: boolean;
  readonly readyReason: ReadyReason;
}

/**
 * Pure readiness logic, derived from config + genesis + pool state. Order
 * matters: the funding kill switch wins over everything (a disabled service
 * is intentionally healthy), then genesis liveness, then pool availability.
 *
 *  - funding off                   → ready    (wallet-generation-only mode)
 *  - genesis not yet synced        → not ready (genesis_wallet_not_ready)
 *  - genesis ready, pool empty     → not ready (utxo_pool_empty)
 *  - genesis ready, pool has funds → ready
 *
 * With the PR3 stub pool, `utxo_pool_empty` is the steady state once genesis
 * is up; the `ready` branch activates when the real pool lands. Kept pure
 * (no module reads) so it can be unit-tested by passing inputs directly.
 */
export function computeReadiness(
  fundingEnabled: boolean,
  genesisReady: boolean,
  stats: PoolStats,
): ReadinessVerdict {
  if (!fundingEnabled) {
    return { ready: true, readyReason: "funding_disabled" };
  }
  if (!genesisReady) {
    return { ready: false, readyReason: "genesis_wallet_not_ready" };
  }
  // NOTE: `leftoverUtxos` is intentionally not consulted yet. Whether a
  // leftover UTXO counts as "spendable → ready" depends on the real pool's
  // reserveUtxo() source priority, which lands with the funding PR. The stub
  // always reports 0 leftovers, so this is moot until then — revisit here
  // when the pool becomes real.
  if (stats.testUtxos === 0 && stats.largeUtxoAmount === null) {
    return { ready: false, readyReason: "utxo_pool_empty" };
  }
  return { ready: true, readyReason: "ready" };
}

/** Gather live state and apply {@link computeReadiness}. */
function currentReadiness(): ReadinessVerdict & { stats: PoolStats } {
  const stats = getPoolStats();
  const verdict = computeReadiness(config.FUNDING_ENABLED, isGenesisReady(), stats);
  return { ...verdict, stats };
}

/**
 * GET /status — operator-facing diagnostic. Always 200; the readiness
 * verdict lives in the body alongside pool counts, the genesis address
 * (when known), and the bootstrap phase. Serialized via JSONBigInt because
 * `largeUtxoAmount` is a bigint once the real pool is populated.
 */
export function handleStatus(_req: Request): Response {
  const readiness = currentReadiness();
  return new Response(
    JSONBigInt.stringify({
      ready: readiness.ready,
      readyReason: readiness.readyReason,
      ...readiness.stats,
      genesisAddress: isGenesisReady() ? getGenesisAddress() : null,
      startup: getStartupState(),
      funding: getFundingLifecycleState(),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

/** GET /ready — readiness probe. 200 when ready, 503 otherwise. */
export function handleReady(_req: Request): Response {
  const readiness = currentReadiness();
  return new Response(
    JSONBigInt.stringify({
      ready: readiness.ready,
      readyReason: readiness.readyReason,
      ...readiness.stats,
    }),
    {
      status: readiness.ready ? 200 : 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** GET /live — liveness probe. Always 200; readiness lives at /ready. */
export function handleLive(_req: Request): Response {
  return Response.json({ live: true });
}

/** Per-service sequence number for fund logs (observability only). */
let fundSeq = 0;

/**
 * POST /fund — reserve a UTXO and send funds to the requested address.
 *
 * 503 SERVICE_NOT_READY until genesis has synced; 400/413 INVALID_REQUEST for
 * a malformed body; on success 200 with `{txId, amount, utxoSource}`. Domain
 * failures (`POOL_EXHAUSTED`, `SPLIT_IN_PROGRESS`, `UTXO_STALE`,
 * `FUND_TIMEOUT`) arrive as {@link ServiceError}s and are mapped to their RFC
 * response via {@link jsonErrorFromService}; anything else is a 500.
 */
export async function handleFund(req: Request): Promise<Response> {
  if (!isGenesisReady()) {
    return jsonErrorFromService(new ServiceNotReadyError());
  }

  const parsed = await parseFundBody(req);
  if (parsed instanceof Response) {
    return parsed;
  }

  const { address, amount } = parsed;

  try {
    const result = await fundAddress(address, amount);
    fundSeq += 1;
    recordFundSuccess();
    const stats = getPoolStats();
    logger.info({
      event: "fund.sent",
      meta: {
        seq: fundSeq,
        txId: result.txId,
        testUtxos: stats.testUtxos,
        utxoSource: result.utxoSource,
        amount: result.amount.toString(),
      },
    });
    return new Response(JSONBigInt.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof ServiceError) {
      // The RFC's documented error codes are surfaced via their descriptors.
      return jsonErrorFromService(err);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ event: "fund.failed", meta: { error: message } });
    return jsonError(500, "INTERNAL_ERROR", message, false);
  }
}

/** GET /metrics — JSON snapshot of request counts, latencies, and pool ops. */
export function handleMetrics(_req: Request): Response {
  return Response.json(getMetricsSnapshot());
}

import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";
import { getSimpleWalletFromCache } from "./wallet.cache";
import { generateMultisigWallet } from "./wallet.service";
import { isGenesisReady, isGenesisFunded, getGenesisAddress } from "./genesis.service";
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
 * Route handlers. Each handler returns a `Response` — including
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
  | "wallet_unfunded"
  | "funds_query_error"
  | "ready";

export interface ReadinessVerdict {
  readonly ready: boolean;
  readonly readyReason: ReadyReason;
}

/**
 * Pure readiness logic, derived from config + genesis liveness + whether the
 * genesis wallet holds funds. Order matters: the funding kill switch wins over
 * everything (a disabled service is intentionally healthy), then genesis
 * liveness, then whether there is anything to fund with.
 *
 *  - funding off                          → ready    (wallet-generation-only mode)
 *  - genesis not yet synced               → not ready (genesis_wallet_not_ready)
 *  - genesis ready, wallet has no funds   → not ready (wallet_unfunded)
 *  - genesis ready, wallet has funds      → ready
 *
 * Readiness gates on the *wallet*, not the test pool — the wallet is the
 * source of truth. As long as it holds spendable UTXOs the service can fund
 * clients (small requests from the pool, large requests wallet-sourced), even
 * when the test pool is momentarily empty between splits. Kept pure (no
 * module reads or I/O) so it can be unit-tested by passing inputs directly;
 * the caller performs the wallet query and passes the boolean.
 */
export function computeReadiness(
  fundingEnabled: boolean,
  genesisReady: boolean,
  walletFunded: boolean,
): ReadinessVerdict {
  if (!fundingEnabled) {
    return { ready: true, readyReason: "funding_disabled" };
  }
  if (!genesisReady) {
    return { ready: false, readyReason: "genesis_wallet_not_ready" };
  }
  if (!walletFunded) {
    return { ready: false, readyReason: "wallet_unfunded" };
  }
  return { ready: true, readyReason: "ready" };
}

/**
 * Live inputs to the readiness verdict. Injected (defaulting to the real
 * genesis accessors) so handler tests can drive the funds-query-error and
 * unfunded branches without mutating process-global genesis state — Bun shares
 * module globals across test files, so a leaked `ready` flag would corrupt an
 * unrelated file's readiness assertions (see the readiness DI guideline in
 * CLAUDE.md).
 */
export interface ReadinessInputs {
  genesisReady: boolean;
  fundsQuery: () => Promise<boolean>;
}

/**
 * Gather live state and apply {@link computeReadiness}. The wallet-funds query
 * (a single `getUtxos` call) runs only when its answer can change the verdict —
 * i.e. funding is enabled and genesis is ready — so /ready stays cheap when the
 * service is disabled or still syncing. Pool stats are gathered only for the
 * /status diagnostic body, not for the readiness verdict.
 *
 * If the funds query itself throws, we report the distinct `funds_query_error`
 * reason rather than `wallet_unfunded`: both are 503, but the former is honest
 * that we could not determine funding (a wallet/storage fault) instead of
 * asserting the wallet is empty.
 */
export async function currentReadiness(
  inputs: ReadinessInputs = { genesisReady: isGenesisReady(), fundsQuery: isGenesisFunded },
): Promise<ReadinessVerdict & { stats: PoolStats }> {
  const stats = getPoolStats();
  const { genesisReady, fundsQuery } = inputs;
  let walletFunded = false;
  if (config.FUNDING_ENABLED && genesisReady) {
    try {
      walletFunded = await fundsQuery();
    } catch (err) {
      // A wallet/storage failure on the funds query must not turn a readiness
      // probe into a 500 — that breaks orchestrator health checks. Report a
      // distinct 503 reason so operators see "couldn't determine funding", not
      // a false "wallet is empty"; the probe self-corrects on the next poll.
      // Logged at error: a persistent inability to read the UTXO store is a
      // production fault, not a routine warning.
      logger.error({
        event: "readiness.funds_query_failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      return { ready: false, readyReason: "funds_query_error", stats };
    }
  }
  const verdict = computeReadiness(config.FUNDING_ENABLED, genesisReady, walletFunded);
  return { ...verdict, stats };
}

/**
 * Genesis state the route handlers read, behind an injectable indirection.
 * Handler tests drive the ready-and-funded path by overriding this rather than
 * mutating the genesis singleton's `ready`/`address`: Bun shares module globals
 * across test files, so a forced `ready` would leak into another file's
 * readiness assertions (the same reason {@link ReadinessInputs} is injected).
 * Defaults to the real genesis accessors; production never overrides it.
 */
interface RouteGenesisView {
  ready: () => boolean;
  address: () => string;
}

let routeGenesis: RouteGenesisView = {
  ready: isGenesisReady,
  address: getGenesisAddress,
};

/**
 * Test-only: override the genesis view the handlers read (e.g. to exercise the
 * ready path). Merges onto the current view; always pair with
 * {@link __resetRouteGenesisForTest} so the override cannot leak across files.
 */
export function __setRouteGenesisForTest(view: Partial<RouteGenesisView>): void {
  routeGenesis = { ...routeGenesis, ...view };
}

/** Test-only: restore the real genesis accessors. */
export function __resetRouteGenesisForTest(): void {
  routeGenesis = { ready: isGenesisReady, address: getGenesisAddress };
}

/** Readiness verdict as the route layer sees genesis (injectable in tests). */
function routeReadiness() {
  return currentReadiness({ genesisReady: routeGenesis.ready(), fundsQuery: isGenesisFunded });
}

/**
 * GET /status — operator-facing diagnostic. Always 200; the readiness
 * verdict lives in the body alongside pool counts, the genesis address
 * (when known), and the bootstrap phase. Serialized via JSONBigInt so any
 * bigint fields added to the envelope survive stringification.
 */
export async function handleStatus(_req: Request): Promise<Response> {
  const readiness = await routeReadiness();
  return new Response(
    JSONBigInt.stringify({
      ready: readiness.ready,
      readyReason: readiness.readyReason,
      ...readiness.stats,
      genesisAddress: routeGenesis.ready() ? routeGenesis.address() : null,
      startup: getStartupState(),
      funding: getFundingLifecycleState(),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

/** GET /ready — readiness probe. 200 when ready, 503 otherwise. */
export async function handleReady(_req: Request): Promise<Response> {
  const readiness = await routeReadiness();
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
  if (!config.FUNDING_ENABLED) {
    // Wallet-generation-only deployment: /fund is not part of its contract and
    // genesis is never initialized, so SERVICE_NOT_READY (retryable) would tell
    // clients to keep retrying an endpoint that can never succeed. Fail fast
    // with a non-retryable error instead.
    return jsonErrorFromService(
      new InvalidRequestError(
        "funding is disabled on this service (FUNDING_ENABLED=false)",
      ),
    );
  }
  if (!routeGenesis.ready()) {
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
    // The raw failure message is surfaced (not a generic string) deliberately:
    // this is an integration-test helper consumed by trusted CI harnesses,
    // where the real detail is exactly what a test author needs to debug. It is
    // also logged for operators. This is not a public, untrusted-facing API, so
    // the usual "don't leak internals" guard would only hide useful signal.
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ event: "fund.failed", meta: { error: message } });
    return jsonError(500, "INTERNAL_ERROR", message, false);
  }
}

/** GET /metrics — JSON snapshot of request counts, latencies, and pool ops. */
export function handleMetrics(_req: Request): Response {
  return Response.json(getMetricsSnapshot());
}

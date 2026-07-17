import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";
import { getSimpleWalletFromCache } from "./wallet.cache";
import { generateMultisigWallet } from "./wallet.service";
import { isGenesisReady, isGenesisFunded, getGenesisAddress } from "./genesis.service";
import { getPoolStats, type PoolStats } from "./utxo-pool.service";
import { getStartupState } from "./startup";
import { config } from "./config";
import { jsonErrorFromService } from "./http";
import { logger } from "./logger";
import { InvalidRequestError } from "./errors";

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
 * Gather live state and apply {@link computeReadiness}. The wallet-funds query
 * (a single `getUtxos` call) runs only when its answer can change the verdict —
 * i.e. funding is enabled and genesis is ready — so /ready stays cheap when the
 * service is disabled or still syncing. Pool stats are gathered only for the
 * /status diagnostic body, not for the readiness verdict.
 */
async function currentReadiness(): Promise<ReadinessVerdict & { stats: PoolStats }> {
  const stats = getPoolStats();
  const genesisReady = isGenesisReady();
  let walletFunded = false;
  if (config.FUNDING_ENABLED && genesisReady) {
    try {
      walletFunded = await isGenesisFunded();
    } catch (err) {
      // A wallet/storage hiccup on the funds query must not turn a readiness
      // probe into a 500 — that breaks orchestrator health checks. Treat it as
      // "not funded": the probe reports 503 wallet_unfunded and self-corrects on
      // the next poll once the wallet answers again.
      logger.warn({
        event: "readiness.funds_query_failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  const verdict = computeReadiness(config.FUNDING_ENABLED, genesisReady, walletFunded);
  return { ...verdict, stats };
}

/**
 * GET /status — operator-facing diagnostic. Always 200; the readiness
 * verdict lives in the body alongside pool counts, the genesis address
 * (when known), and the bootstrap phase. Serialized via JSONBigInt so any
 * bigint fields added to the envelope survive stringification.
 */
export async function handleStatus(_req: Request): Promise<Response> {
  const readiness = await currentReadiness();
  return new Response(
    JSONBigInt.stringify({
      ready: readiness.ready,
      readyReason: readiness.readyReason,
      ...readiness.stats,
      genesisAddress: isGenesisReady() ? getGenesisAddress() : null,
      startup: getStartupState(),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

/** GET /ready — readiness probe. 200 when ready, 503 otherwise. */
export async function handleReady(_req: Request): Promise<Response> {
  const readiness = await currentReadiness();
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

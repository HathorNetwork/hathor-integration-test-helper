import {
  initGenesisWallet,
  isGenesisReady,
  getGenesisWallet,
  waitForUtxoUnlock,
} from "./genesis.service";
import {
  getPoolStats,
  releaseReservation,
  type PoolStats,
  type ReservedUtxo,
  type Utxo,
} from "./utxo-pool.service";
import {
  splitUtxo,
  reserveLargeFromWallet,
  repopulatePoolFromWallet,
} from "./split.service";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Funding subsystem bootstrap.
 *
 * Brings the genesis wallet online (when funding is enabled), populates the
 * UTXO pool from its available outputs, and performs the initial split so the
 * pool has test-sized UTXOs to fund from. A coarse lifecycle phase is exposed
 * via GET /status.
 *
 * The bootstrap never throws into the server: a bad seed, unreachable
 * fullnode, or failed split transitions to `degraded` (recorded with
 * `lastError`) while the HTTP server stays up serving wallet-generation
 * endpoints.
 */

/** Lifecycle phases of the funding subsystem bootstrap. */
type StartupPhase = "idle" | "initializing" | "ready" | "disabled" | "degraded";

/** Externally visible startup state exposed by GET /status. */
interface StartupState {
  phase: StartupPhase;
  lastError: string | null;
  lastUpdatedAt: string;
}

const startupState: StartupState = {
  phase: "idle",
  lastError: null,
  lastUpdatedAt: new Date().toISOString(),
};

let bootPromise: Promise<void> | null = null;

/**
 * Collaborators the bootstrap depends on. Injectable so the state machine
 * can be unit-tested with plain fakes — no fullnode, no module mocking (Bun's
 * `mock.module` is process-global and leaks across test files).
 */
export interface BootstrapDeps {
  readonly fundingEnabled: boolean;
  readonly initGenesisWallet: () => Promise<void>;
  readonly isGenesisReady: () => boolean;
  readonly populatePoolFromWallet: () => Promise<void>;
  readonly getPoolStats: () => PoolStats;
  readonly runInitialSplit: () => Promise<void>;
}

/**
 * Re-query wallet-lib for available UTXOs and repopulate the pool from
 * scratch. Production implementation of {@link BootstrapDeps.populatePoolFromWallet}.
 */
async function refreshPoolFromWallet(): Promise<void> {
  await repopulatePoolFromWallet(getGenesisWallet());
}

/**
 * Collaborators the initial-split routine depends on. Injectable so the retry/
 * seeding logic is unit-testable with plain fakes (no fullnode, no real
 * backoff waits) — the same DI-not-mock.module convention used elsewhere.
 */
export interface InitialSplitDeps {
  readonly reserveLargeFromWallet: (
    minAmount: bigint,
    options?: { includeLocked?: boolean },
  ) => Promise<ReservedUtxo | null>;
  readonly waitForUtxoUnlock: (txId: string) => Promise<void>;
  readonly splitUtxo: (utxo: Utxo) => Promise<void>;
  readonly releaseReservation: (utxo: { txId: string; index: number }) => void;
  readonly refreshPool: () => Promise<void>;
  readonly getPoolStats: () => PoolStats;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Production wiring for {@link runInitialSplitWithRetry}. */
function defaultInitialSplitDeps(): InitialSplitDeps {
  return {
    reserveLargeFromWallet,
    waitForUtxoUnlock,
    splitUtxo,
    releaseReservation,
    refreshPool: refreshPoolFromWallet,
    getPoolStats,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Attempt the first UTXO split up to `maxAttempts` times with linear backoff,
 * refreshing the pool between attempts. The output to split is sourced from the
 * wallet via {@link reserveLargeFromWallet}. Production implementation of
 * {@link BootstrapDeps.runInitialSplit}.
 *
 * This runs only when the pool is empty (see {@link bootstrapFunding}), so its
 * job is to leave the pool with at least one test UTXO. A required split that
 * finds nothing to split is NOT a clean success: it would leave `/ready`
 * reporting `200` (readiness gates on wallet funds, not the pool) while every
 * standard `/fund` throws `POOL_EXHAUSTED` with nothing to refill it and no
 * self-heal path. So the routine retries, and if it still cannot seed the pool
 * it throws — the bootstrap records that as `degraded` rather than `ready`.
 */
export async function runInitialSplitWithRetry(
  maxAttempts: number,
  deps: InitialSplitDeps = defaultInitialSplitDeps(),
): Promise<void> {
  // A large output must yield at least one test UTXO plus change, i.e. hold at
  // least 2 × UTXO_SPLIT_AMOUNT — the same threshold rescan and background
  // refill use. (Below that, splitUtxo computes maxOutputs < 1 and skips.)
  const minSplittable = config.UTXO_SPLIT_AMOUNT * 2n;
  let lastError = "no large output available to seed the pool";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // includeLocked: a fresh testnet's only large output is the still-height-
    // locked genesis reward. Select it here even though it is locked, then wait
    // the lock out below — the default (available-only) filter would hide it and
    // seeding could never start. The live /fund path uses the default filter.
    const reserved = await deps.reserveLargeFromWallet(minSplittable, {
      includeLocked: true,
    });

    if (reserved !== null) {
      try {
        await deps.waitForUtxoUnlock(reserved.utxo.txId);
        await deps.splitUtxo(reserved.utxo);
        if (deps.getPoolStats().testUtxos > 0) return;
        lastError = "split produced no test UTXOs";
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Unknown split error";
        // waitForUtxoUnlock can reject with the output still reserved (splitUtxo
        // releases on its own failure, but the unlock wait runs before it), so
        // release here or the large output stays wedged in reservedSet and the
        // retry can never re-reserve it. Idempotent, so double-release is safe.
        deps.releaseReservation(reserved.utxo);
      }
      logger.warn({
        event: "startup.initial_split_failed",
        meta: { attempt, maxAttempts, error: lastError },
      });
    } else {
      // reserveLargeFromWallet returns null both when no output is large enough
      // AND when every large candidate is already reserved. Don't assert the
      // former — name the honest, recoverable state instead of its opposite.
      lastError = "no unreserved large output available to seed the pool";
      logger.warn({
        event: "startup.initial_split_no_large",
        meta: { attempt, maxAttempts },
      });
    }

    // A refresh may re-pool test-sized outputs that appeared meanwhile (genesis
    // still settling, or a concurrent producer); if so, the pool is seeded. A
    // refresh throw must not abort the loop — that would collapse the remaining
    // attempts into one. Record it and let the next attempt retry.
    try {
      await deps.refreshPool();
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Unknown refresh error";
      logger.warn({
        event: "startup.initial_split_refresh_failed",
        meta: { attempt, maxAttempts, error: lastError },
      });
    }
    if (deps.getPoolStats().testUtxos > 0) return;

    if (attempt < maxAttempts) {
      await deps.sleep(1000 * attempt);
    }
  }

  throw new Error(
    `Initial split could not seed the pool after ${maxAttempts} attempts: ${lastError}`,
  );
}

/** Production wiring: read the live config and the real genesis + pool services. */
function defaultDeps(): BootstrapDeps {
  return {
    fundingEnabled: config.FUNDING_ENABLED,
    initGenesisWallet,
    isGenesisReady,
    populatePoolFromWallet: refreshPoolFromWallet,
    getPoolStats,
    runInitialSplit: () => runInitialSplitWithRetry(3),
  };
}

/** Transition to a new startup phase, recording the timestamp. */
function setStartupState(phase: StartupPhase, lastError: string | null): void {
  startupState.phase = phase;
  startupState.lastError = lastError;
  startupState.lastUpdatedAt = new Date().toISOString();
}

/** Return a shallow copy of the current startup state (safe to expose). */
export function getStartupState(): StartupState {
  return { ...startupState };
}

/**
 * Bootstrap the genesis wallet and UTXO pool in the background. Safe to call
 * multiple times — initialization runs once and subsequent calls await the
 * same promise.
 */
export async function bootstrapFunding(
  deps: BootstrapDeps = defaultDeps(),
): Promise<void> {
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    if (!deps.fundingEnabled) {
      setStartupState("disabled", null);
      logger.info({
        event: "startup.funding_disabled",
        meta: { reason: "FUNDING_ENABLED=false" },
      });
      return;
    }

    setStartupState("initializing", null);
    logger.info({ event: "startup.begin" });

    await deps.initGenesisWallet();
    if (!deps.isGenesisReady()) {
      // initGenesisWallet resolved but the wallet never reported ready —
      // surface it as degraded rather than silently claiming success.
      setStartupState("degraded", "Genesis wallet did not become ready");
      logger.error({ event: "startup.genesis_not_ready" });
      return;
    }

    // Genesis is up: populate the pool from its UTXOs, and if there are no
    // test-sized UTXOs yet, perform the initial split (which sources its large
    // input from the wallet live).
    await deps.populatePoolFromWallet();
    const stats = deps.getPoolStats();
    if (stats.testUtxos === 0) {
      logger.info({ event: "startup.initial_split_required" });
      await deps.runInitialSplit();
    }

    setStartupState("ready", null);
    logger.info({ event: "startup.ready" });
  })().catch((err) => {
    const message = err instanceof Error ? err.message : "Unknown startup error";
    setStartupState("degraded", message);
    logger.error({ event: "startup.failed", meta: { error: message } });
  });

  return bootPromise;
}

/** Test-only: reset the boot promise and state back to `idle`. */
export function __resetStartupForTest(): void {
  bootPromise = null;
  setStartupState("idle", null);
}

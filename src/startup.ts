import {
  initGenesisWallet,
  isGenesisReady,
  getGenesisWallet,
  waitForUtxoUnlock,
} from "./genesis.service";
import { getPoolStats, type PoolStats } from "./utxo-pool.service";
import {
  splitUtxo,
  reserveLargeFromWallet,
  repopulatePoolFromWallet,
} from "./fund.service";
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
 * Attempt the first UTXO split up to `maxAttempts` times with linear backoff,
 * refreshing the pool between attempts. The output to split is sourced from the
 * wallet via {@link reserveLargeFromWallet}. Production implementation of
 * {@link BootstrapDeps.runInitialSplit}.
 */
async function runInitialSplitWithRetry(maxAttempts: number): Promise<void> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reserved = await reserveLargeFromWallet(config.UTXO_SPLIT_AMOUNT);
    if (reserved === null) {
      // Nothing large to split — not a startup failure: the bootstrap stays
      // ready and a later fund/rescan can still populate the pool, so return
      // cleanly rather than degrading.
      logger.info({ event: "startup.initial_split_skipped_no_large" });
      return;
    }

    try {
      await waitForUtxoUnlock(reserved.utxo.txId);
      await splitUtxo(reserved.utxo);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Unknown split error";
      logger.warn({
        event: "startup.initial_split_failed",
        meta: { attempt, maxAttempts, error: lastError },
      });
      await refreshPoolFromWallet();

      if (attempt < maxAttempts) {
        const backoffMs = 1000 * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw new Error(
    `Initial split failed after ${maxAttempts} attempts: ${lastError ?? "unknown"}`,
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

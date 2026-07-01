import { NATIVE_TOKEN_UID } from "@hathor/wallet-lib/lib/constants";
import {
  initGenesisWallet,
  isGenesisReady,
  getGenesisWallet,
  waitForUtxoUnlock,
} from "./genesis.service";
import {
  populateFromUtxos,
  reserveUtxo,
  getPoolStats,
  type PoolStats,
} from "./utxo-pool.service";
import { splitUtxo } from "./fund.service";
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
  const wallet = getGenesisWallet();
  const utxos: Array<{ txId: string; index: number; value: bigint }> = [];
  for await (const utxo of wallet.getAvailableUtxos({ token: NATIVE_TOKEN_UID })) {
    utxos.push({
      txId: utxo.txId,
      index: utxo.index,
      value: BigInt(utxo.value),
    });
  }
  populateFromUtxos(utxos);
}

/**
 * Attempt the first UTXO split up to `maxAttempts` times with linear backoff,
 * refreshing the pool between attempts. Production implementation of
 * {@link BootstrapDeps.runInitialSplit}.
 */
async function runInitialSplitWithRetry(maxAttempts: number): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stats = getPoolStats();
      if (stats.largeUtxoAmount === null) {
        throw new Error("No large UTXO available for initial split");
      }

      const { utxo } = await reserveUtxo(stats.largeUtxoAmount);
      await waitForUtxoUnlock(utxo.txId);
      await splitUtxo(utxo);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown split error";
      logger.warn({
        event: "startup.initial_split_failed",
        meta: { attempt, maxAttempts, error: message },
      });
      await refreshPoolFromWallet();

      if (attempt < maxAttempts) {
        const backoffMs = 1000 * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw new Error(`Initial split failed after ${maxAttempts} attempts`);
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
    // test-sized UTXOs yet but a large one exists, perform the initial split.
    await deps.populatePoolFromWallet();
    const stats = deps.getPoolStats();
    if (stats.testUtxos === 0 && stats.largeUtxoAmount !== null) {
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

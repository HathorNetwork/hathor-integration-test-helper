import { initGenesisWallet, isGenesisReady } from "./genesis.service";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Funding subsystem bootstrap.
 *
 * PR3 scope: bring the genesis wallet online (when funding is enabled) and
 * expose a coarse lifecycle phase via GET /status. UTXO-pool population and
 * the initial split land in the funding PRs; this module intentionally does
 * not touch the pool yet.
 *
 * The bootstrap never throws into the server: a bad seed or unreachable
 * fullnode transitions to `degraded` (recorded with `lastError`) while the
 * HTTP server stays up serving the wallet-generation endpoints.
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
}

/** Production wiring: read the live config and the real genesis service. */
function defaultDeps(): BootstrapDeps {
  return {
    fundingEnabled: config.FUNDING_ENABLED,
    initGenesisWallet,
    isGenesisReady,
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
 * Bootstrap the genesis wallet in the background. Safe to call multiple
 * times — initialization runs once and subsequent calls await the same
 * promise.
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

import HathorWallet from "@hathor/wallet-lib/lib/new/wallet";
import WalletConnection from "@hathor/wallet-lib/lib/new/connection";
import walletLibConfig from "@hathor/wallet-lib/lib/config";
import { TX_WEIGHT_CONSTANTS, NATIVE_TOKEN_UID } from "@hathor/wallet-lib/lib/constants";
import Transaction from "@hathor/wallet-lib/lib/models/transaction";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Genesis wallet lifecycle plus the low-level primitives the funding flow
 * builds on. The genesis wallet holds the funded UTXOs the service spends
 * from; it is initialized at startup (only when funding is enabled) and
 * connects to the configured fullnode.
 *
 * This module owns the wallet's connect-and-sync lifecycle, the accessors the
 * routes read, the funded verdict ({@link isGenesisFunded}), and the reward-
 * lock wait ({@link waitForRewardUnlock}) that gates spending a height-locked
 * reward UTXO. UTXO-pool population and the on-chain split transaction itself
 * live in the fund/pool modules, not here.
 */

let wallet: InstanceType<typeof HathorWallet> | null = null;
let genesisAddress: string | null = null;
let ready = false;
// In-flight init: concurrent callers await this shared promise instead of each
// building a second wallet. Cleared once init settles so a failed attempt can
// be retried — on failure the singleton is left null (see below), never a
// half-built wallet a `wallet !== null` guard would wrongly treat as ready.
let initPromise: Promise<void> | null = null;

const SYNC_CHECK_INTERVAL_MS = 500;

/**
 * Initialize the genesis wallet from `GENESIS_SEED_WORDS`: connect to the
 * fullnode, start the wallet, and resolve once it has finished syncing.
 *
 * Throws if the wallet cannot start (bad seed, unreachable fullnode). The
 * caller (`bootstrapFunding`) catches that and transitions to `degraded`,
 * keeping the service alive for wallet-generation endpoints.
 *
 * Concurrency-safe: the genesis wallet is a process singleton, so a completed
 * init is a no-op and an in-flight one is shared. Production only ever calls
 * this once (behind `bootstrapFunding`'s boot promise); the in-flight guard
 * keeps the primitive correct on its own rather than relying on that caller.
 */
export async function initGenesisWallet(): Promise<void> {
  // Already initialized: repeat call is a caller bug — building another wallet
  // would open a duplicate connection and orphan the first — so no-op.
  if (wallet !== null) {
    logger.warn({ event: "genesis.init_skipped_already_initialized" });
    return;
  }
  // An init is already running: share it instead of starting a second wallet.
  if (initPromise !== null) {
    return initPromise;
  }

  initPromise = (async () => {
    logger.info({ event: "genesis.starting" });

    walletLibConfig.setTxMiningUrl(config.TX_MINING_URL);
    logger.info({
      event: "genesis.tx_mining_url",
      meta: { txMiningUrl: config.TX_MINING_URL },
    });

    // On private testnets with --test-mode-tx-weight the fullnode accepts
    // weight=1, but wallet-lib hardcodes txMinWeight=14 / coefficient=1.6 /
    // k=100, producing high weights the dev-miner can't solve quickly. Override
    // all three plus calculateWeight to pin the minimum, matching wallet-lib's
    // own integration-test setup.
    if (config.TX_MIN_WEIGHT) {
      // Local const narrows the optional config field to `number` for the closure.
      const txMinWeight = config.TX_MIN_WEIGHT;
      TX_WEIGHT_CONSTANTS.txMinWeight = txMinWeight;
      TX_WEIGHT_CONSTANTS.txWeightCoefficient = 0;
      TX_WEIGHT_CONSTANTS.txMinWeightK = 0;
      Transaction.prototype.calculateWeight = function (): number {
        return txMinWeight;
      };
      logger.info({ event: "genesis.tx_weight_overridden", meta: { txMinWeight } });
    }

    const connection = new WalletConnection({
      network: config.NETWORK,
      servers: [config.HATHOR_NODE_URL],
    } as ConstructorParameters<typeof WalletConnection>[0]);

    // Build into a local, publishing `wallet` only after a clean start+sync
    // below. A throw before then leaves the singleton null, so the rollback in
    // the catch has nothing half-built to expose and a retry starts fresh.
    const w = new HathorWallet({
      seed: config.GENESIS_SEED_WORDS,
      connection,
      password: config.WALLET_PASSWORD,
      pinCode: config.WALLET_PIN_CODE,
    });

    await w.start();
    logger.info({ event: "genesis.wallet_started_waiting_sync" });

    // Bounded wait: `w.start()` can resolve while the wallet never reaches
    // `isReady()` (stalled sync, wrong network). Without a deadline the
    // bootstrap would hang at `initializing` forever; on timeout we reject so
    // the caller transitions to `degraded`.
    await waitUntilReady(
      () => w.isReady(),
      config.GENESIS_SYNC_TIMEOUT_MS,
      SYNC_CHECK_INTERVAL_MS,
    );

    genesisAddress = await w.getAddressAtIndex(0);
    wallet = w;
    ready = true;
    logger.info({ event: "genesis.ready", meta: { genesisAddress } });
  })();

  try {
    await initPromise;
  } catch (err) {
    // Roll back any partial state so a retry sees a clean "not initialized"
    // rather than a wallet stuck mid-start.
    wallet = null;
    genesisAddress = null;
    ready = false;
    throw err;
  } finally {
    initPromise = null;
  }
}

/**
 * Poll `isReady` every `intervalMs` until it returns true, or reject once
 * `timeoutMs` elapses. Extracted from {@link initGenesisWallet} so the
 * timeout/degrade path is unit-testable without a real fullnode.
 */
export async function waitUntilReady(
  isReady: () => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isReady()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Genesis wallet did not become ready within ${timeoutMs}ms`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function getGenesisWallet(): InstanceType<typeof HathorWallet> {
  if (!wallet) throw new Error("Genesis wallet not initialized");
  return wallet;
}

export function getGenesisAddress(): string {
  if (!genesisAddress) throw new Error("Genesis wallet not initialized");
  return genesisAddress;
}

export function isGenesisReady(): boolean {
  return ready;
}

/**
 * Test-only override for {@link isGenesisFunded}. `null` means "no override —
 * query the real wallet". Set through {@link __setGenesisStateForTest} so the
 * funded verdict is testable without a real wallet.
 */
let fundedOverrideForTest: boolean | null = null;

/**
 * Minimal wallet surface for the funded check — just the `getUtxos` call
 * {@link walletHoldsSpendableFunds} needs. Declared structurally (a subset of
 * wallet-lib's `HathorWallet`) so the verdict is unit-testable with a plain
 * fake, mirroring the {@link RewardLockStorage} seam.
 */
export interface FundQueryWallet {
  getUtxos(options: { token: string }): Promise<{ total_utxos_available: bigint }>;
}

/**
 * Pure funded verdict: does `wallet` hold at least one spendable native-token
 * UTXO? Split out from {@link isGenesisFunded} so the `> 0n` boundary is
 * unit-testable against a fake wallet, without the real genesis singleton.
 *
 * `total_utxos_available` counts only UTXOs wallet-lib's `getUtxos` classifies
 * as unlocked: it runs each UTXO through `Transaction.isHeightLocked` and buckets
 * height-locked rewards into `total_utxos_locked` instead. That split is
 * independent of the `only_available_utxos` option (which only filters the
 * returned `utxos[]` list), so a genesis wallet whose sole UTXO is a still-locked
 * block reward correctly reads as unfunded here until it unlocks — no extra
 * filtering flag needed.
 */
export async function walletHoldsSpendableFunds(
  wallet: FundQueryWallet,
): Promise<boolean> {
  const details = await wallet.getUtxos({ token: NATIVE_TOKEN_UID });
  return details.total_utxos_available > 0n;
}

/**
 * Whether the genesis wallet currently holds any spendable native-token UTXOs.
 * Backs the readiness verdict (see {@link computeReadiness}).
 *
 * A single `getUtxos` call answers it, reading the wallet's local synced UTXO
 * store — a cheap in-process lookup, not a fullnode round-trip.
 */
export async function isGenesisFunded(): Promise<boolean> {
  if (fundedOverrideForTest !== null) {
    return fundedOverrideForTest;
  }
  return walletHoldsSpendableFunds(getGenesisWallet());
}

/**
 * Test-only: override the funded verdict without a fullnode, so the funded
 * unit test can pin it. Deliberately narrow — it cannot set `ready` or
 * `genesisAddress`: the readiness verdict is driven through injected inputs
 * ({@link ReadinessInputs} in routes.ts), so no test forces the `ready` global
 * true. That is what keeps Bun's process-shared module state from leaking a
 * spurious readiness across test files. Pass `funded: null` to drop the
 * override; use {@link __resetGenesisStateForTest} to clear everything.
 */
export function __setGenesisStateForTest(state: { funded?: boolean | null }): void {
  if (state.funded !== undefined) fundedOverrideForTest = state.funded;
}

/**
 * Test-only: inject the wallet singleton directly so the idempotency guard in
 * {@link initGenesisWallet} can be exercised without a fullnode (a real init
 * would connect). Accepts `unknown` because tests pass a lightweight stand-in,
 * not a full `HathorWallet`. Always pair with {@link __resetGenesisStateForTest}
 * so the injected wallet does not leak into other test files.
 */
export function __setGenesisWalletForTest(w: unknown): void {
  wallet = w as InstanceType<typeof HathorWallet>;
}

/**
 * Test-only: reset all genesis module state (wallet, in-flight init, ready
 * flag, address, and funded override) to its pre-init defaults, so a test that
 * mutated it cannot pollute later files — Bun shares module globals across the
 * process.
 */
export function __resetGenesisStateForTest(): void {
  wallet = null;
  initPromise = null;
  ready = false;
  genesisAddress = null;
  fundedOverrideForTest = null;
}

/**
 * Storage surface used by the reward-lock wait. Declared structurally (a
 * subset of wallet-lib's storage) so the poll loop is unit-testable with a
 * plain fake — no real fullnode, mirroring the {@link waitUntilReady} seam.
 */
export interface RewardLockStorage {
  // `| null` mirrors wallet-lib's `IStorage.version` (unset until the fullnode
  // API version is fetched), so the real storage satisfies this interface
  // structurally — no cast needed at the production call site below.
  version?: { reward_spend_min_blocks?: number } | null;
  getTx(txId: string): Promise<{ height?: number | null } | null>;
  getCurrentHeight(): Promise<number>;
}

/**
 * Wait until a block-reward UTXO's height lock has expired.
 *
 * Block reward UTXOs in Hathor are height-locked: unspendable until
 * `reward_spend_min_blocks` blocks have been mined after the block that
 * contains them (`locked = currentHeight < blockHeight + reward_spend_min_blocks`).
 * On a fresh private testnet the genesis UTXO is almost always still locked
 * at startup; attempting the split early pollutes the fullnode's mempool with
 * a tx that fails "inputs already spent"/"full validation failed". We instead
 * poll `getCurrentHeight()` until the lock expires.
 *
 * Pure seam over a storage object so it can be unit-tested; the production
 * entry point {@link waitForUtxoUnlock} passes the real wallet's storage.
 */
export async function waitForRewardUnlock(
  storage: RewardLockStorage,
  txId: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 600_000; // 10 minutes safety net

  // Distinguish "field genuinely absent" from an explicit 0. Absent means the
  // fullnode API version isn't populated yet (storage not synced, or a wallet-
  // lib shape change) — treating that as "no lock" and proceeding is exactly
  // how a still-locked reward gets spent, the failure this function prevents.
  // We still return (tolerant, so a caller isn't hard-blocked) but log it so
  // the skip is observable rather than silent.
  const configuredLock = storage.version?.reward_spend_min_blocks;
  if (configuredLock === undefined || configuredLock === null) {
    logger.warn({ event: "genesis.reward_lock_version_unavailable", meta: { txId } });
    return;
  }
  if (configuredLock === 0) {
    // Chain genuinely configured with no reward lock — nothing to wait for.
    return;
  }
  const rewardLock = configuredLock;

  const tx = await storage.getTx(txId);
  if (tx == null) {
    // Tx not in local storage yet (not synced/propagated); can't compute the
    // lock. Observable skip rather than silent optimism.
    logger.warn({ event: "genesis.reward_lock_tx_not_found", meta: { txId } });
    return;
  }
  const blockHeight = tx.height;
  if (blockHeight == null) {
    // Tx present but carries no height — genuinely not a height-locked block,
    // so there is nothing to wait on.
    logger.warn({ event: "genesis.reward_lock_unknown_block_height", meta: { txId } });
    return;
  }

  // wallet-lib frees a reward UTXO at
  // `currentHeight >= blockHeight + reward_spend_min_blocks`
  // (transaction.isHeightLocked). We wait one block past that as a deliberate
  // conservative margin, so the split is never attempted on the exact boundary
  // block.
  const unlockHeight = blockHeight + rewardLock + 1;
  let currentHeight = await storage.getCurrentHeight();
  if (currentHeight >= unlockHeight) {
    return; // Already unlocked.
  }

  const blocksNeeded = unlockHeight - currentHeight;
  logger.info({
    event: "genesis.reward_lock_waiting",
    meta: { txId, blockHeight, rewardLock, unlockHeight, currentHeight, blocksNeeded },
  });

  const start = Date.now();
  while (currentHeight < unlockHeight) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timeout waiting for reward unlock (need height ${unlockHeight}, at ${currentHeight})`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    currentHeight = await storage.getCurrentHeight();
  }

  logger.info({
    event: "genesis.reward_lock_unlocked",
    meta: { txId, currentHeight, unlockHeight },
  });
}

/**
 * Production entry point: wait for the genesis wallet's UTXO reward lock to
 * expire before spending it. Thin wrapper over {@link waitForRewardUnlock}
 * with the real wallet's storage.
 */
export async function waitForUtxoUnlock(txId: string): Promise<void> {
  const w = getGenesisWallet();
  await waitForRewardUnlock(w.storage, txId);
}

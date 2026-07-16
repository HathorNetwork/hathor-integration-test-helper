import HathorWallet from "@hathor/wallet-lib/lib/new/wallet";
import WalletConnection from "@hathor/wallet-lib/lib/new/connection";
import walletLibConfig from "@hathor/wallet-lib/lib/config";
import { TX_WEIGHT_CONSTANTS, NATIVE_TOKEN_UID } from "@hathor/wallet-lib/lib/constants";
import Transaction from "@hathor/wallet-lib/lib/models/transaction";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Genesis wallet lifecycle. The genesis wallet holds the funded UTXOs the
 * service spends from; it is initialized at startup (only when funding is
 * enabled) and connects to the configured fullnode.
 *
 * UTXO-pool population and the on-chain split are deliberately NOT here.
 * This module owns just the wallet's connect-and-sync lifecycle plus the
 * accessors the routes read.
 */

let wallet: InstanceType<typeof HathorWallet> | null = null;
let genesisAddress: string | null = null;
let ready = false;

const SYNC_CHECK_INTERVAL_MS = 500;

/**
 * Initialize the genesis wallet from `GENESIS_SEED_WORDS`: connect to the
 * fullnode, start the wallet, and resolve once it has finished syncing.
 *
 * Throws if the wallet cannot start (bad seed, unreachable fullnode). The
 * caller (`bootstrapFunding`) catches that and transitions to `degraded`,
 * keeping the service alive for wallet-generation endpoints.
 */
export async function initGenesisWallet(): Promise<void> {
  logger.info({ event: "genesis.starting" });

  walletLibConfig.setTxMiningUrl(config.TX_MINING_URL);
  logger.info({
    event: "genesis.tx_mining_url",
    meta: { txMiningUrl: config.TX_MINING_URL },
  });

  // On private testnets with --test-mode-tx-weight the fullnode accepts
  // weight=1, but wallet-lib hardcodes txMinWeight=14 / coefficient=1.6 / k=100,
  // producing high weights the dev-miner can't solve quickly. Override all
  // three plus calculateWeight to pin the minimum, matching wallet-lib's own
  // integration-test setup.
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

  wallet = new HathorWallet({
    seed: config.GENESIS_SEED_WORDS,
    connection,
    password: config.WALLET_PASSWORD,
    pinCode: config.WALLET_PIN_CODE,
  });

  await wallet.start();
  logger.info({ event: "genesis.wallet_started_waiting_sync" });

  // Bounded wait: `wallet.start()` can resolve while the wallet never reaches
  // `isReady()` (stalled sync, wrong network). Without a deadline the bootstrap
  // would hang at `initializing` forever; on timeout we reject so the caller
  // transitions to `degraded`.
  await waitUntilReady(
    () => wallet?.isReady() ?? false,
    config.GENESIS_SYNC_TIMEOUT_MS,
    SYNC_CHECK_INTERVAL_MS,
  );

  genesisAddress = await wallet.getAddressAtIndex(0);
  ready = true;
  logger.info({ event: "genesis.ready", meta: { genesisAddress } });
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
 * query the real wallet". Set through {@link __setGenesisStateForTest} so
 * route/handler tests can exercise funded/unfunded readiness without a wallet.
 */
let fundedOverrideForTest: boolean | null = null;

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
  const details = await getGenesisWallet().getUtxos({ token: NATIVE_TOKEN_UID });
  return details.total_utxos_available > 0n;
}

/**
 * Test-only: force the genesis readiness flag, address, and funded verdict
 * without a fullnode, so route/handler tests can exercise the ready path via
 * dependency injection (not `mock.module`, which leaks process-globally across
 * Bun test files). Pass `funded: null` to drop the override.
 */
export function __setGenesisStateForTest(state: {
  ready?: boolean;
  address?: string | null;
  funded?: boolean | null;
}): void {
  if (state.ready !== undefined) ready = state.ready;
  if (state.address !== undefined) genesisAddress = state.address;
  if (state.funded !== undefined) fundedOverrideForTest = state.funded;
}

/**
 * Storage surface used by the reward-lock wait. Declared structurally (a
 * subset of wallet-lib's storage) so the poll loop is unit-testable with a
 * plain fake — no real fullnode, mirroring the {@link waitUntilReady} seam.
 */
export interface RewardLockStorage {
  version?: { reward_spend_min_blocks?: number };
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

  const rewardLock = storage.version?.reward_spend_min_blocks ?? 0;
  if (rewardLock === 0) {
    // No reward lock configured — nothing to wait for.
    return;
  }

  const tx = await storage.getTx(txId);
  const blockHeight = tx?.height;
  if (blockHeight == null) {
    // Not a block or height unknown — can't compute lock, skip.
    logger.warn({ event: "genesis.reward_lock_unknown_block_height", meta: { txId } });
    return;
  }

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
  await waitForRewardUnlock(w.storage as unknown as RewardLockStorage, txId);
}

import HathorWallet from "@hathor/wallet-lib/lib/new/wallet";
import WalletConnection from "@hathor/wallet-lib/lib/new/connection";
import walletLibConfig from "@hathor/wallet-lib/lib/config";
import { TX_WEIGHT_CONSTANTS } from "@hathor/wallet-lib/lib/constants";
import Transaction from "@hathor/wallet-lib/lib/models/transaction";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Genesis wallet lifecycle. The genesis wallet holds the funded UTXOs the
 * service spends from; it is initialized at startup (only when funding is
 * enabled) and connects to the configured fullnode.
 *
 * UTXO-pool population and the on-chain split are deliberately NOT here —
 * they belong to the funding PRs. This module owns just the wallet's
 * connect-and-sync lifecycle plus the accessors the routes read.
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
    // Capture in a local const so the closure below sees a `number` rather
    // than `number | undefined` — the optional config field cannot be
    // narrowed through a function expression that re-reads it.
    const txMinWeight = config.TX_MIN_WEIGHT;
    TX_WEIGHT_CONSTANTS.txMinWeight = txMinWeight;
    TX_WEIGHT_CONSTANTS.txWeightCoefficient = 0;
    TX_WEIGHT_CONSTANTS.txMinWeightK = 0;
    Transaction.prototype.calculateWeight = function () {
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
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (isReady()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(
          new Error(
            `Genesis wallet did not become ready within ${timeoutMs}ms`,
          ),
        );
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
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

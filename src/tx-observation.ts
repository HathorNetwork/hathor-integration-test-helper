import { logger } from "./logger";

/**
 * Wallet surface used for tx observation.
 *
 * Matches the relevant subset of `HathorWallet` from `@hathor/wallet-lib`,
 * declared structurally so unit tests can substitute a mock without
 * importing the full wallet class.
 */
export interface TxObservationWallet {
  getTx(id: string): Promise<unknown | null>;
  on(event: "new-tx", listener: (tx: { tx_id: string } | undefined) => void): unknown;
  off(event: "new-tx", listener: (tx: { tx_id: string } | undefined) => void): unknown;
}

/**
 * Resolve once `txId` has been observed by the wallet, or after `timeoutMs`
 * elapses. Used to defer releasing a UTXO reservation until the consuming
 * transaction is visible in the wallet's storage / WS pipeline.
 *
 * Returns `true` if the tx was observed, `false` on timeout. Never rejects.
 */
export async function awaitTxObserved(
  wallet: TxObservationWallet,
  txId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (observed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wallet.off("new-tx", handler);
      resolve(observed);
    };

    const handler = (newTx: { tx_id: string } | undefined) => {
      if (newTx?.tx_id === txId) finish(true);
    };

    // Subscribe BEFORE the storage check: a 'new-tx' event that arrives while
    // getTx is in flight would otherwise be missed and fall through to the full
    // timeout (releasing the reservation late).
    wallet.on("new-tx", handler);
    const timer = setTimeout(() => finish(false), timeoutMs);

    // Fast path: the tx may already be in storage (its event could even have
    // fired before we subscribed, e.g. during the broadcast HTTP round-trip).
    // Re-check after subscribing so neither ordering loses the observation.
    wallet
      .getTx(txId)
      .then((tx) => {
        if (tx) finish(true);
      })
      .catch((err) => {
        logger.warn({
          event: "tx_observation.getTx_failed",
          meta: {
            txId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      });
  });
}

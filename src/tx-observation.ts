import { logger } from "./logger";

/**
 * Transaction-observation primitive for the funding subsystem.
 *
 * A dependency-free building block (only a logger) that resolves once a given
 * transaction is observed by the wallet. The funding flow uses it to defer
 * releasing a UTXO reservation until the spending transaction is visible in
 * the wallet — upholding the reservation-release-on-failure invariant. Kept
 * standalone so it can be reasoned about and tested in isolation from the
 * request path.
 */

/**
 * Wallet surface used for tx observation.
 *
 * Matches the relevant subset of `HathorWallet` from `@hathor/wallet-lib`,
 * declared structurally so unit tests can substitute a mock without
 * importing the full wallet class.
 */
export interface TxObservationWallet {
  getTx(id: string): Promise<unknown>;
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
    // `let` because `timer` is forward-declared here but only assigned once the
    // timeout is armed below — after `finish`/`handler` are defined. Those
    // closures capture the binding (`finish` reads it via `clearTimeout(timer)`),
    // and a `const` can't be declared now and assigned later. Assignment happens
    // before `wallet.on`, so any synchronous listener already sees a live timer.
    let timer: ReturnType<typeof setTimeout>;

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
    timer = setTimeout(() => finish(false), timeoutMs);
    wallet.on("new-tx", handler);

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

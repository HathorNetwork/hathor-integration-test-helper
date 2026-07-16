import { describe, test, expect, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getReservedKeys,
  releaseReservation,
  reserveLarge,
} from "../../src/utxo-pool.service";
import { rescanUtxoPool, __resetFundStateForTest } from "../../src/fund.service";
import {
  scheduleReservationRelease,
  __setFundDepsForTest,
  __resetFundDepsForTest,
  type FundWallet,
} from "../../src/split.service";
import type { TxObservationWallet } from "../../src/tx-observation";

// Covers the rescan coalescing contract and the observation-timeout branch of
// the deferred reservation release. DI seam, not mock.module (CLAUDE.md).

function restoreSharedState(): void {
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
}

afterEach(() => {
  restoreSharedState();
});

describe("rescanUtxoPool coalescing", () => {
  test("concurrent rescans share a single wallet query", async () => {
    let getUtxosCalls = 0;
    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async getUtxos() {
            getUtxosCalls += 1;
            // Test-sized output → pool non-empty after repopulate → no
            // post-rescan split (which would issue further queries).
            return { utxos: [{ tx_id: "u", index: 0, amount: 1000n }] };
          },
        }) as unknown as FundWallet,
    });

    // Three callers fire in the same tick; the last two coalesce onto the
    // first's in-flight rescan rather than each re-querying the wallet.
    await Promise.all([rescanUtxoPool(), rescanUtxoPool(), rescanUtxoPool()]);

    expect(getUtxosCalls).toBe(1);
  });
});

describe("scheduleReservationRelease observation timeout", () => {
  test("releases the reservation when the tx is never observed", async () => {
    // A wallet that never reports the tx (getTx null, no 'new-tx' event), so
    // awaitTxObserved can only resolve via the timeout branch.
    function neverObservingWallet(): TxObservationWallet {
      const emitter = new EventEmitter();
      return Object.assign(emitter, {
        async getTx() {
          return null;
        },
      }) as unknown as TxObservationWallet;
    }

    const reserved = reserveLarge({ txId: "spent", index: 0, amount: 50000n });
    expect(reserved).not.toBeNull();
    expect(getReservedKeys()).toContain("spent:0");

    // Short timeout keeps the test fast; awaiting the (normally fire-and-forget)
    // promise lets us assert the deferred release actually happened.
    await scheduleReservationRelease(
      neverObservingWallet(),
      { txId: "spent", index: 0 },
      "spending-tx",
      "fund",
      20,
    );

    expect(getReservedKeys()).not.toContain("spent:0");
  });
});

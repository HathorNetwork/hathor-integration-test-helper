import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
  reserveLarge,
} from "../../src/utxo-pool.service";
import {
  fundAddress,
  splitUtxo,
  __setFundDepsForTest,
  __resetFundDepsForTest,
  __resetFundStateForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/fund.service";
import { UtxoStaleError } from "../../src/errors";

// These tests pin the reservation invariant on failure paths: a build/sign
// throw must NEVER strand a UTXO in reservedSet (rescan and admitToPool both
// skip reserved keys, so a leak never heals), and a terminally-stale UTXO must
// NOT be returned to the pool (re-pooling a spent output fails the next
// request stale again). DI seam, not mock.module (CLAUDE.md).

const genesisAddress = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";

function restoreSharedState(): void {
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
}

const fakeBuilder = (): FundTemplateBuilder => {
  const builder: FundTemplateBuilder = {
    addSetVarAction: () => builder,
    addRawInput: () => builder,
    addTokenOutput: () => builder,
    addCompleteAction: () => builder,
    build: () => ({}),
  };
  return builder;
};

beforeEach(() => {
  populateFromUtxos([]);
});

afterEach(() => {
  restoreSharedState();
});

describe("attemptFund reservation invariant on failure", () => {
  test("releases and re-pools the UTXO when buildTxTemplate throws", async () => {
    populateFromUtxos([{ txId: "utxo", index: 0, value: 1000n }]);
    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async buildTxTemplate() {
            throw new Error("pin rejected"); // pre-broadcast, non-stale
          },
          async getTx(id: string) {
            return { id };
          },
          on() {},
          off() {},
        }) as unknown as FundWallet,
      getGenesisAddress: () => genesisAddress,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {},
    });

    await expect(fundAddress(genesisAddress, 500n)).rejects.toThrow(
      "pin rejected",
    );

    // Reservation released, and the never-spent UTXO returned to the bucket.
    expect(getReservedKeys()).toHaveLength(0);
    expect(getPoolStats().testUtxos).toBe(1);
  });

  test("does not re-pool a UTXO that was spent on the terminal stale attempt", async () => {
    populateFromUtxos([{ txId: "stale", index: 0, value: 1000n }]);
    let sendAttempts = 0;
    __setFundDepsForTest({
      getGenesisWallet: () => {
        const emitter = new EventEmitter();
        return Object.assign(emitter, {
          async buildTxTemplate() {
            return {
              hash: `tx-${sendAttempts + 1}`,
              outputs: [{ value: 500 }, { value: 500 }],
            };
          },
          // Rescan re-pools this so the retry can reserve — and be stale too.
          async getUtxos() {
            return { utxos: [{ tx_id: "rescanned", index: 0, amount: 1000n }] };
          },
          async getTx(id: string) {
            return { id };
          },
        }) as unknown as FundWallet;
      },
      getGenesisAddress: () => genesisAddress,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {
        sendAttempts += 1;
        throw new Error("input already been spent"); // stale on every attempt
      },
    });

    await expect(fundAddress(genesisAddress, 500n)).rejects.toBeInstanceOf(
      UtxoStaleError,
    );

    // Two attempts (stale → rescan → retry → stale). The spent UTXO is NOT
    // returned to the pool, and no reservation leaked.
    expect(sendAttempts).toBe(2);
    expect(getPoolStats().testUtxos).toBe(0);
    expect(getReservedKeys()).toHaveLength(0);
  });
});

describe("splitUtxo reservation invariant on failure", () => {
  test("releases the reserved large output when buildTxTemplate throws", async () => {
    // Reserve the large output the way production does before splitting.
    const reserved = reserveLarge({ txId: "big", index: 0, amount: 100000n });
    expect(reserved).not.toBeNull();
    expect(getReservedKeys()).toHaveLength(1);

    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async buildTxTemplate() {
            throw new Error("sign failed");
          },
          async getTx(id: string) {
            return { id };
          },
          on() {},
          off() {},
        }) as unknown as FundWallet,
      getGenesisAddress: () => genesisAddress,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {},
    });

    await expect(
      splitUtxo({ txId: "big", index: 0, amount: 100000n }),
    ).rejects.toThrow("sign failed");

    // The large output is released so a later wallet query can rediscover it.
    expect(getReservedKeys()).toHaveLength(0);
  });
});

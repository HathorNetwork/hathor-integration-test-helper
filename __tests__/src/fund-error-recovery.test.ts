import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import {
  fundAddress,
  __setFundDepsForTest,
  __resetFundDepsForTest,
  __resetFundStateForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/fund.service";

// A non-stale send failure must return the reserved UTXO to the pool and NOT
// retry (only stale-UTXO errors trigger a rescan + retry). DI seam, no mocks.

const genesisAddress = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";
let sendAttempts = 0;

function fakeWallet(): FundWallet {
  return {
    async buildTxTemplate() {
      return { hash: "tx-fail", outputs: [{ value: 500 }, { value: 500 }] };
    },
    async *getAvailableUtxos() {},
    async getTx(id: string) {
      return { id };
    },
    on() {},
    off() {},
  } as unknown as FundWallet;
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
  sendAttempts = 0;
  populateFromUtxos([]);
  __setFundDepsForTest({
    getGenesisWallet: fakeWallet,
    getGenesisAddress: () => genesisAddress,
    newTemplateBuilder: fakeBuilder,
    runSendTransaction: async () => {
      sendAttempts += 1;
      throw new Error("transaction weight is too low"); // non-stale
    },
  });
});

afterEach(() => {
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
});

describe("fund.service non-stale error recovery", () => {
  test("returns the UTXO to the pool and does not retry", async () => {
    populateFromUtxos([{ txId: "good-utxo", index: 0, value: 1000n }]);
    expect(getPoolStats().testUtxos).toBe(1);

    await expect(fundAddress(genesisAddress, 500n)).rejects.toThrow(
      "transaction weight is too low",
    );

    // The test-sized UTXO is returned to testUtxos; no rescan/retry happened.
    const stats = getPoolStats();
    expect(stats.testUtxos).toBe(1);
    expect(stats.leftoverUtxos).toBe(0);
    expect(sendAttempts).toBe(1);
  });
});

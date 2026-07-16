import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  populateFromUtxos,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import {
  PoolExhaustedError,
  UtxoStaleError,
  SplitInProgressError,
} from "../../src/errors";
import {
  fundAddress,
  __setFundDepsForTest,
  __resetFundDepsForTest,
  __resetFundStateForTest,
  __setSplitInProgressForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/fund.service";

// fund.service typed-error contract, driven through the DI seam (no
// mock.module). Sending behavior is controlled via runSendTransaction.

const genesisAddress = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";
let sendBehavior: "stale-then-stale" | "stale-then-ok" = "stale-then-stale";
let sendAttempts = 0;
let txCounter = 0;

function fakeWallet(): FundWallet {
  return {
    async buildTxTemplate() {
      txCounter += 1;
      return { hash: `tx-${txCounter}`, outputs: [{ value: 500 }, { value: 500 }] };
    },
    async getUtxos() {
      // Fresh UTXO for the retry after a rescan.
      return { utxos: [{ tx_id: "fresh-after-rescan", index: 0, amount: 1000n }] };
    },
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
  txCounter = 0;
  populateFromUtxos([]);
  __setFundDepsForTest({
    getGenesisWallet: fakeWallet,
    getGenesisAddress: () => genesisAddress,
    newTemplateBuilder: fakeBuilder,
    runSendTransaction: async () => {
      sendAttempts += 1;
      if (sendBehavior === "stale-then-stale") {
        throw new Error("UTXO has already been spent");
      }
      if (sendAttempts === 1) {
        throw new Error("UTXO has already been spent");
      }
    },
  });
});

afterEach(() => {
  __setSplitInProgressForTest(false);
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
});

describe("fund.service typed errors", () => {
  test("throws UtxoStaleError when stale on the retry attempt", async () => {
    sendBehavior = "stale-then-stale";
    populateFromUtxos([{ txId: "stale-utxo", index: 0, value: 1000n }]);

    await expect(fundAddress(genesisAddress, 500n)).rejects.toBeInstanceOf(
      UtxoStaleError,
    );
    expect(sendAttempts).toBe(2);
  });

  test("succeeds on stale-then-ok with no error surfaced", async () => {
    sendBehavior = "stale-then-ok";
    populateFromUtxos([{ txId: "stale-utxo", index: 0, value: 1000n }]);

    const result = await fundAddress(genesisAddress, 500n);
    expect(result.txId).toMatch(/^tx-/);
    expect(sendAttempts).toBe(2);
  });

  test("PoolExhaustedError surfaces unchanged when no split is running", async () => {
    populateFromUtxos([]);
    await expect(fundAddress(genesisAddress, 500n)).rejects.toBeInstanceOf(
      PoolExhaustedError,
    );
  });

  test("PoolExhaustedError becomes SplitInProgressError mid-split", async () => {
    populateFromUtxos([]);
    __setSplitInProgressForTest(true);
    await expect(fundAddress(genesisAddress, 500n)).rejects.toBeInstanceOf(
      SplitInProgressError,
    );
  });
});

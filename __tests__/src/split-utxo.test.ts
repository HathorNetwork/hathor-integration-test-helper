import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import {
  splitUtxo,
  __setFundDepsForTest,
  __resetFundDepsForTest,
  __resetFundStateForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/fund.service";

// Restore the shared pool + fund-service singletons after each test.
function restoreSharedState(): void {
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
}

// DI seam, NOT mock.module (process-global, leaks across files — CLAUDE.md).

let buildCount = 0;
let sendCount = 0;
let lastSendError: Error | null = null;

function makeWallet(): FundWallet {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    async buildTxTemplate() {
      buildCount += 1;
      const outputs = Array.from({ length: 11 }, (_, i) => ({
        value: i < 10 ? 1000 : 90000,
      }));
      return { hash: `split-tx-${buildCount}`, outputs };
    },
    async *getAvailableUtxos() {},
    // Pretend the split tx is already observed so the reservation
    // release runs without waiting on a 'new-tx' event.
    async getTx(id: string) {
      return { id };
    },
  }) as unknown as FundWallet;
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
  buildCount = 0;
  sendCount = 0;
  lastSendError = null;
  populateFromUtxos([]);
  const wallet = makeWallet();
  __setFundDepsForTest({
    getGenesisWallet: () => wallet,
    getGenesisAddress: () => "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk",
    newTemplateBuilder: fakeBuilder,
    runSendTransaction: async () => {
      sendCount += 1;
      if (lastSendError) throw lastSendError;
    },
  });
});

afterEach(() => {
  restoreSharedState();
});

describe("splitUtxo", () => {
  test("splits a large UTXO into test-sized UTXOs and change", async () => {
    // Amount chosen so maxOutputs = 10, matching the mock's 11 outputs
    // (10 test-sized + 1 change). This exercises the change-output branch.
    await splitUtxo({ txId: "big", index: 0, amount: 11000n });

    expect(sendCount).toBe(1);
    expect(buildCount).toBe(1);

    const stats = getPoolStats();
    expect(stats.testUtxos).toBe(10);
    expect(stats.largeUtxoAmount).toBe(90000n);
  });

  test("returns small UTXO as change when too small to split", async () => {
    // Amount too small for even 1 split output (< 2 * UTXO_SPLIT_AMOUNT)
    await splitUtxo({ txId: "tiny", index: 0, amount: 500n });

    // Should not have attempted to build or send a transaction
    expect(buildCount).toBe(0);
    expect(sendCount).toBe(0);

    // The UTXO is returned as change to the pool
    const stats = getPoolStats();
    expect(stats.leftoverUtxos).toBe(1);
  });

  test("propagates send transaction errors", async () => {
    lastSendError = new Error("mining failed");

    await expect(
      splitUtxo({ txId: "fail", index: 0, amount: 100000n }),
    ).rejects.toThrow("mining failed");
  });
});

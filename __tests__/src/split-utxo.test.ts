import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import { __resetFundStateForTest } from "../../src/fund.service";
import {
  splitUtxo,
  __setFundDepsForTest,
  __resetFundDepsForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/split.service";

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
    // The large change output (90000) is not pooled — only the 10 test-sized
    // outputs are; the change stays on-chain and a later wallet query finds it.
  });

  test("drops the input as dust when too small to split", async () => {
    // Amount too small for even 1 split output (< 2 * UTXO_SPLIT_AMOUNT)
    await splitUtxo({ txId: "tiny", index: 0, amount: 500n });

    // Should not have attempted to build or send a transaction
    expect(buildCount).toBe(0);
    expect(sendCount).toBe(0);

    // A sub-split-size input is dust: it cannot fund a standard request and is
    // not pooled (the genesis wallet retains it on-chain). The pool is empty.
    const stats = getPoolStats();
    expect(stats.testUtxos).toBe(0);
  });

  test("propagates send transaction errors", async () => {
    lastSendError = new Error("mining failed");

    await expect(
      splitUtxo({ txId: "fail", index: 0, amount: 100000n }),
    ).rejects.toThrow("mining failed");
  });
});

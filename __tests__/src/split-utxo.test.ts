import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
  reserveLarge,
  reserveUtxo,
} from "../../src/utxo-pool.service";
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

  test("pools outputs by value, not position — change mid-array is skipped", async () => {
    // The pool must ingest exactly the outputs whose value is splitAmount,
    // wherever they sit. Emit the change in the MIDDLE of the outputs array:
    // positional trust (indices 0..maxOutputs-1) would pool the 90000n change
    // at index 1 as a test UTXO; value verification skips it and pools the
    // split-sized outputs at their true indices.
    const emitter = new EventEmitter();
    const wallet = Object.assign(emitter, {
      async buildTxTemplate() {
        buildCount += 1;
        return {
          hash: "reordered-tx",
          outputs: [{ value: 1000 }, { value: 90000 }, { value: 1000 }],
        };
      },
      async getTx(id: string) {
        return { id };
      },
    }) as unknown as FundWallet;
    __setFundDepsForTest({
      getGenesisWallet: () => wallet,
      getGenesisAddress: () => "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk",
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {},
    });

    await splitUtxo({ txId: "big", index: 0, amount: 100000n });

    expect(getPoolStats().testUtxos).toBe(2);
    const indices = [reserveUtxo(500n).utxo, reserveUtxo(500n).utxo].map((u) => {
      expect(u.txId).toBe("reordered-tx");
      return u.index;
    });
    expect(indices.sort()).toEqual([0, 2]);
  });

  test("propagates send transaction errors", async () => {
    lastSendError = new Error("mining failed");

    await expect(
      splitUtxo({ txId: "fail", index: 0, amount: 100000n }),
    ).rejects.toThrow("mining failed");
  });

  test("releases the reserved input when the split send fails", async () => {
    // The input must be reserved through the real pool first — production
    // reserves via reserveLargeFromWallet before calling splitUtxo. Passing a
    // bare literal (as the other tests do) leaves reservedSet empty, so
    // releaseReservation is a no-op and its deletion can't be detected. Reserve
    // for real, then assert the failed split empties reservedSet.
    const utxo = { txId: "reserved-send-fail", index: 0, amount: 100000n };
    expect(reserveLarge(utxo)).not.toBeNull();
    expect(getReservedKeys()).toEqual(["reserved-send-fail:0"]);

    lastSendError = new Error("mining failed");
    await expect(splitUtxo(utxo)).rejects.toThrow("mining failed");

    // Left reserved, the large output stays wedged in reservedSet forever.
    expect(getReservedKeys()).toEqual([]);
  });

  test("releases the reserved input when dropped as dust", async () => {
    // The sub-split-size (maxOutputs < 1) early-out has its own release. Amount
    // is chosen to satisfy reserveLarge (> UTXO_SPLIT_AMOUNT, so it reserves)
    // yet be too small to split (< 2 × UTXO_SPLIT_AMOUNT, so maxOutputs < 1).
    // Reserve for real so the release is observable, then assert it fires.
    const utxo = { txId: "reserved-dust", index: 0, amount: 1500n };
    expect(reserveLarge(utxo)).not.toBeNull();
    expect(getReservedKeys()).toEqual(["reserved-dust:0"]);

    await splitUtxo(utxo);

    expect(getReservedKeys()).toEqual([]);
  });
});

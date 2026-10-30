import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { EventEmitter } from "node:events";
import { ShieldedOutputMode } from "@hathor/wallet-lib/lib/shielded/types";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
  reserveFee,
} from "../../src/utxo-pool.service";
import {
  fundAddress,
  shieldedFundFee,
  __resetFundStateForTest,
} from "../../src/fund.service";
import {
  __setFundDepsForTest,
  __resetFundDepsForTest,
  type FundTemplateBuilder,
  type FundWallet,
  type SendOutputsRequest,
} from "../../src/split.service";
import { PoolExhaustedError, UtxoStaleError } from "../../src/errors";
import { generateSimpleWallet } from "../../src/wallet.service";

// DI seam, NOT mock.module (see CLAUDE.md): fakes for the genesis wallet,
// the template path and the explicit-input send.

const GENESIS = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";
const wallet = generateSimpleWallet();
const LEGACY = wallet.addresses[0]!;
const SHIELDED = wallet.shieldedAddresses![0]!.shieldedBase58;

type GetUtxosOptions = Parameters<FundWallet["getUtxos"]>[0];

/** Outputs the fake wallet reports, filtered like wallet-lib's query. */
let walletUtxos: Array<{ tx_id: string; index: number; amount: bigint }> = [];
let getUtxosCalls: GetUtxosOptions[] = [];
let sendOutputsCalls: SendOutputsRequest[] = [];
let templateSends = 0;
let sendOutputsFailures: Error[] = [];
/** Hash the fake send returns; `undefined` means a generated one. */
let sendOutputsHash: string | null | undefined;
/** Per-tx timestamps the fake wallet reports; unlisted txs are old. */
let txTimestamps: Record<string, number> = {};

function makeWallet(): FundWallet {
  return Object.assign(new EventEmitter(), {
    async buildTxTemplate() {
      return { hash: "template-tx", outputs: [] };
    },
    async getUtxos(options: GetUtxosOptions) {
      getUtxosCalls.push(options);
      const utxos = walletUtxos.filter(
        (u) =>
          (options.amount_bigger_than === undefined || u.amount > options.amount_bigger_than) &&
          (options.amount_smaller_than === undefined || u.amount < options.amount_smaller_than),
      );
      return { utxos };
    },
    async getTx(id: string) {
      return { id, timestamp: txTimestamps[id] ?? 0 };
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

function restoreSharedState(): void {
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
}

beforeEach(() => {
  walletUtxos = [];
  getUtxosCalls = [];
  sendOutputsCalls = [];
  templateSends = 0;
  sendOutputsFailures = [];
  sendOutputsHash = undefined;
  txTimestamps = {};
  const w = makeWallet();
  __setFundDepsForTest({
    getGenesisWallet: () => w,
    getGenesisAddress: () => GENESIS,
    newTemplateBuilder: fakeBuilder,
    runSendTransaction: async () => {
      templateSends += 1;
    },
    sendOutputs: async (_wallet, request) => {
      sendOutputsCalls.push(request);
      const failure = sendOutputsFailures.shift();
      if (failure) throw failure;
      return {
        hash: sendOutputsHash === undefined ? `shielded-tx-${sendOutputsCalls.length}` : sendOutputsHash,
      };
    },
  });
});

afterEach(restoreSharedState);

/** Let the deferred reservation releases (observation is immediate) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("shieldedFundFee", () => {
  test("charges both halves of the split shielded output", () => {
    expect(shieldedFundFee(null)).toBe(0n);
    expect(shieldedFundFee("amount")).toBe(2n);
    expect(shieldedFundFee("full")).toBe(4n);
  });
});

describe("fundAddress with a shielded amount", () => {
  test("a default-size fund pays the fee from the smallest covering fee output", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);
    walletUtxos = [
      { tx_id: "fee-big", index: 0, amount: 500n },
      { tx_id: "fee-dust", index: 0, amount: 3n },
      { tx_id: "fee-small", index: 1, amount: 10n },
    ];

    const result = await fundAddress(SHIELDED, 1000n, "full");

    expect(result).toEqual({
      txId: "shielded-tx-1",
      amount: 1000n,
      utxoSource: "test",
      shielded: "full",
    });
    // The test UTXO pays the amount; 3 can't cover the 4-unit fee, so the
    // smallest output that can is taken, sparing the 500.
    expect(getUtxosCalls[0]).toMatchObject({
      amount_bigger_than: 3n,
      amount_smaller_than: 1000n,
      only_available_utxos: true,
    });
    expect(sendOutputsCalls[0]).toEqual({
      outputs: [
        {
          address: SHIELDED,
          value: 1000n,
          token: "00",
          shieldedMode: ShieldedOutputMode.FULLY_SHIELDED,
        },
      ],
      inputs: [
        { txId: "test", index: 0 },
        { txId: "fee-small", index: 1 },
      ],
      changeAddress: GENESIS,
    });
    expect(templateSends).toBe(0);

    await settle();
    expect(getReservedKeys()).toHaveLength(0);
  });

  test("asks the fee input only for what the test UTXO's change can't cover", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);
    walletUtxos = [{ tx_id: "fee", index: 0, amount: 1n }];

    // 999 + 2 = 1001: the test UTXO's change pays 1 of the fee.
    await fundAddress(SHIELDED, 999n, "amount");

    expect(getUtxosCalls[0]!.amount_bigger_than).toBe(0n);
    expect(sendOutputsCalls[0]!.inputs).toEqual([
      { txId: "test", index: 0 },
      { txId: "fee", index: 0 },
    ]);
    expect(sendOutputsCalls[0]!.outputs[0]).toMatchObject({
      shieldedMode: ShieldedOutputMode.AMOUNT_SHIELDED,
    });
  });

  test("skips a fee output created this second", async () => {
    const nowSeconds = 1_800_000_000;
    setSystemTime(new Date(nowSeconds * 1000 + 500));
    try {
      populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);
      walletUtxos = [
        { tx_id: "fresh-change", index: 0, amount: 10n },
        { tx_id: "old-seed", index: 0, amount: 500n },
      ];
      // Spending it now would give the fund the same timestamp as its parent.
      txTimestamps = { "fresh-change": nowSeconds, "old-seed": nowSeconds - 1 };

      await fundAddress(SHIELDED, 1000n, "amount");

      expect(sendOutputsCalls[0]!.inputs[1]).toEqual({ txId: "old-seed", index: 0 });
    } finally {
      setSystemTime();
    }
  });

  test("waits for a fresh fee output to mature when no large output is free", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);
    walletUtxos = [{ tx_id: "seed", index: 0, amount: 500n }];
    txTimestamps = { seed: Number.MAX_SAFE_INTEGER };
    setTimeout(() => {
      txTimestamps = {};
    }, 10);

    const result = await fundAddress(SHIELDED, 1000n, "amount", 2000);

    expect(result.utxoSource).toBe("test");
    expect(sendOutputsCalls[0]!.inputs).toEqual([
      { txId: "test", index: 0 },
      { txId: "seed", index: 0 },
    ]);
  });

  test("a fund whose fee fits the test UTXO needs no fee input", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);

    await fundAddress(SHIELDED, 998n, "amount");

    expect(getUtxosCalls).toHaveLength(0);
    expect(sendOutputsCalls[0]!.inputs).toEqual([{ txId: "test", index: 0 }]);
  });

  test("falls back to a large output when no fee output is free", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);
    walletUtxos = [{ tx_id: "large", index: 0, amount: 50_000n }];

    const result = await fundAddress(SHIELDED, 1000n, "amount");

    expect(result.utxoSource).toBe("large");
    expect(sendOutputsCalls[0]!.inputs).toEqual([{ txId: "large", index: 0 }]);
    // The large query covers amount and fee.
    expect(getUtxosCalls[1]!.amount_bigger_than).toBe(1001n);
    // The test UTXO was never taken.
    expect(getPoolStats().testUtxos).toBe(1);
  });

  test("a large amount draws one large output covering amount and fee", async () => {
    walletUtxos = [{ tx_id: "large", index: 0, amount: 50_000n }];

    const result = await fundAddress(SHIELDED, 2000n, "full");

    expect(result.utxoSource).toBe("large");
    expect(getUtxosCalls).toHaveLength(1);
    expect(getUtxosCalls[0]!.amount_bigger_than).toBe(2003n);
    expect(sendOutputsCalls[0]!.inputs).toEqual([{ txId: "large", index: 0 }]);
  });

  test("an empty test pool releases the fee input and reports POOL_EXHAUSTED", async () => {
    walletUtxos = [{ tx_id: "fee", index: 0, amount: 500n }];

    await expect(fundAddress(SHIELDED, 1000n, "amount")).rejects.toBeInstanceOf(
      PoolExhaustedError,
    );
    expect(getReservedKeys()).toHaveLength(0);
  });

  test("a stale input releases both inputs and retries once", async () => {
    populateFromUtxos([
      { txId: "test-1", index: 0, value: 1000n },
      { txId: "test-2", index: 0, value: 1000n },
    ]);
    // The rescan rebuilds the pool from what the wallet reports.
    walletUtxos = [
      { tx_id: "test-1", index: 0, amount: 1000n },
      { tx_id: "test-2", index: 0, amount: 1000n },
      { tx_id: "fee", index: 0, amount: 500n },
    ];
    sendOutputsFailures = [new Error("Transaction input has already been spent")];

    const result = await fundAddress(SHIELDED, 1000n, "amount");

    expect(result.txId).toBe("shielded-tx-2");
    expect(sendOutputsCalls).toHaveLength(2);
    // The rescan skipped the reserved test-1, so the retry draws test-2.
    expect(sendOutputsCalls[1]!.inputs[0]).toEqual({ txId: "test-2", index: 0 });
    // The fee output was released before the retry, so it could be reused.
    expect(sendOutputsCalls[1]!.inputs[1]).toEqual({ txId: "fee", index: 0 });
    await settle();
    expect(getReservedKeys()).toHaveLength(0);
  });

  test("a second stale failure releases both inputs and pools neither", async () => {
    populateFromUtxos([
      { txId: "test-1", index: 0, value: 1000n },
      { txId: "test-2", index: 0, value: 1000n },
    ]);
    walletUtxos = [
      { tx_id: "test-1", index: 0, amount: 1000n },
      { tx_id: "test-2", index: 0, amount: 1000n },
      { tx_id: "fee", index: 0, amount: 500n },
    ];
    const stale = () => new Error("Transaction input has already been spent");
    sendOutputsFailures = [stale(), stale()];

    await expect(fundAddress(SHIELDED, 1000n, "amount")).rejects.toBeInstanceOf(
      UtxoStaleError,
    );
    expect(sendOutputsCalls).toHaveLength(2);
    expect(getReservedKeys()).toHaveLength(0);
    // Neither attempt's test input went back: either may be the spent one.
    expect(getPoolStats().testUtxos).toBe(0);
  });

  test("a send without a hash releases both inputs", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);
    walletUtxos = [{ tx_id: "fee", index: 0, amount: 500n }];
    sendOutputsHash = null;

    await expect(fundAddress(SHIELDED, 1000n, "amount")).rejects.toThrow(
      "Fund transaction completed without a hash",
    );
    expect(getReservedKeys()).toHaveLength(0);
    expect(getPoolStats().testUtxos).toBe(0);
  });

  test("a non-stale failure returns the test input to the pool, not the fee input", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);
    walletUtxos = [{ tx_id: "fee", index: 0, amount: 500n }];
    sendOutputsFailures = [new Error("mining rejected")];

    await expect(fundAddress(SHIELDED, 1000n, "amount")).rejects.toThrow(
      "mining rejected",
    );
    expect(getReservedKeys()).toHaveLength(0);
    expect(getPoolStats().testUtxos).toBe(1);
  });
});

describe("fundAddress to a shielded address with a transparent amount", () => {
  test("sends through the explicit-input path with no fee", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);

    const result = await fundAddress(SHIELDED, 1000n);

    expect(result.shielded).toBeNull();
    expect(sendOutputsCalls[0]).toEqual({
      outputs: [{ address: SHIELDED, value: 1000n, token: "00" }],
      inputs: [{ txId: "test", index: 0 }],
      changeAddress: GENESIS,
    });
    expect(getUtxosCalls).toHaveLength(0);
  });
});

describe("fundAddress to a legacy address", () => {
  test("keeps using the template path", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);

    const result = await fundAddress(LEGACY, 1000n);

    expect(result).toMatchObject({ txId: "template-tx", shielded: null });
    expect(templateSends).toBe(1);
    expect(sendOutputsCalls).toHaveLength(0);
  });

  test("refuses a shielded amount instead of sending it transparent", async () => {
    populateFromUtxos([{ txId: "test", index: 0, value: 1000n }]);

    await expect(fundAddress(LEGACY, 998n, "amount")).rejects.toThrow(
      "Cannot send a shielded amount to non-shielded address",
    );
    expect(templateSends).toBe(0);
    expect(getReservedKeys()).toHaveLength(0);
    expect(getPoolStats().testUtxos).toBe(1);
  });
});

describe("reserveFee", () => {
  test("claims only below-split outputs that are not in flight", () => {
    expect(reserveFee({ txId: "pool-sized", index: 0, amount: 1000n })).toBeNull();
    expect(reserveFee({ txId: "large", index: 0, amount: 5000n })).toBeNull();

    const fee = { txId: "fee", index: 0, amount: 10n };
    expect(reserveFee(fee)).toEqual({ utxo: fee, source: "fee" });
    expect(reserveFee(fee)).toBeNull();
  });
});

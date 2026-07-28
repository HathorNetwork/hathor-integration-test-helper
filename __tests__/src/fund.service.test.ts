import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import { fundAddress, __resetFundStateForTest } from "../../src/fund.service";
import {
  reserveLargeFromWallet,
  __setFundDepsForTest,
  __resetFundDepsForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/split.service";

// This file mutates the real (shared) pool + fund-service singletons; restore
// them after each test so unrelated files see a clean, empty pool.
function restoreSharedState(): void {
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
}

// DI seam, NOT mock.module: Bun's module mocks are process-global and leak
// across test files (see CLAUDE.md). We inject plain fakes for the genesis
// wallet, template builder, and send-transaction runner instead.

const GENESIS = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";

let sendAttempts = 0;

// Wallet fake exposing the surface fund.service touches:
//   - buildTxTemplate for tx construction, getUtxos for rescan repopulation
//   - getTx + 'new-tx' event for the observation-based reservation release
function makeWallet(): FundWallet {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    async buildTxTemplate() {
      return {
        hash: `tx-${sendAttempts + 1}`,
        outputs: [{ value: 500 }, { value: 500 }],
      };
    },
    async getUtxos() {
      return { utxos: [{ tx_id: "rescanned-utxo", index: 0, amount: 1000n }] };
    },
    // Pretend every tx is already observed by the wallet — fund.service
    // can release reservations immediately without waiting on 'new-tx'.
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
  sendAttempts = 0;
  const wallet = makeWallet();
  __setFundDepsForTest({
    getGenesisWallet: () => wallet,
    getGenesisAddress: () => "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk",
    newTemplateBuilder: fakeBuilder,
    runSendTransaction: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error("input already been spent");
      }
    },
  });
});

afterEach(() => {
  restoreSharedState();
});

describe("reserveLargeFromWallet", () => {
  type GetUtxosOptions = {
    token: string;
    amount_bigger_than?: bigint;
    only_available_utxos?: boolean;
  };
  let getUtxosCalls: GetUtxosOptions[];
  let availableLarge: Array<{ tx_id: string; index: number; amount: bigint }>;

  // Wallet fake exposing only the getUtxos surface reserveLargeFromWallet uses;
  // it records the query options so we can assert the size filter is pushed down.
  function makeQueryWallet(): FundWallet {
    return {
      async getUtxos(options: GetUtxosOptions) {
        getUtxosCalls.push(options);
        return { utxos: availableLarge };
      },
    } as unknown as FundWallet;
  }

  beforeEach(() => {
    getUtxosCalls = [];
    availableLarge = [];
    __setFundDepsForTest({ getGenesisWallet: makeQueryWallet });
  });

  test("pushes the size filter into the query and reserves a covering output", async () => {
    availableLarge = [{ tx_id: "big", index: 2, amount: 50000n }];

    const reserved = await reserveLargeFromWallet(30000n);

    // The wallet does the filtering: amount_bigger_than is a strict '>', so a
    // '>= minAmount' contract is expressed as minAmount - 1. only_available_utxos
    // keeps locked outputs out of the candidate set.
    expect(getUtxosCalls).toHaveLength(1);
    expect(getUtxosCalls[0]!.amount_bigger_than).toBe(29999n);
    expect(getUtxosCalls[0]!.only_available_utxos).toBe(true);

    expect(reserved).not.toBeNull();
    expect(reserved!.utxo).toEqual({ txId: "big", index: 2, amount: 50000n });
    expect(reserved!.source).toBe("large");
  });

  test("returns null when the wallet exposes no covering output", async () => {
    availableLarge = [];

    const reserved = await reserveLargeFromWallet(30000n);

    expect(reserved).toBeNull();
    expect(getUtxosCalls).toHaveLength(1);
  });
});

describe("fund.service stale UTXO recovery", () => {
  test("rescans and retries once when reserved utxo is stale", async () => {
    // Seed the real pool with a UTXO that will become "stale"
    populateFromUtxos([{ txId: "stale", index: 0, value: 1000n }]);

    const result = await fundAddress("WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk", 500n);

    expect(result.txId).toBe("tx-2");
    expect(result.utxoSource).toBe("test");
    // 2 attempts: first fails (stale), rescan repopulates pool, second succeeds
    expect(sendAttempts).toBe(2);
  });
});

/**
 * Install deps whose built tx has the given outputs and hash, and which always
 * broadcasts successfully — so these tests observe only the post-send path.
 */
function installOutputDeps(
  outputs: Array<{ value: number | bigint }>,
  hash: string | undefined,
): void {
  const emitter = new EventEmitter();
  const wallet = Object.assign(emitter, {
    async buildTxTemplate() {
      return { hash, outputs };
    },
    async getUtxos() {
      return { utxos: [] };
    },
    async getTx(id: string) {
      return { id };
    },
  }) as unknown as FundWallet;

  __setFundDepsForTest({
    getGenesisWallet: () => wallet,
    getGenesisAddress: () => GENESIS,
    newTemplateBuilder: fakeBuilder,
    runSendTransaction: async () => {},
  });
}

describe("the fund path does not re-pool change", () => {
  test("a test-sized second output is left on-chain, not pooled", async () => {
    // The decisive shape: outputs differ, and index 1 is exactly pool-sized —
    // precisely what a positional `returnChange({index: 1})` would pick up.
    // It must not be pooled: returnChange guards on size, not ownership, and on
    // a default-sized request the recipient's output is indistinguishable from
    // change, so a mispick would pool a UTXO genesis does not own.
    populateFromUtxos([{ txId: "seed", index: 0, value: 1000n }]);
    installOutputDeps([{ value: 500n }, { value: 1000n }], "fund-tx");

    const before = getPoolStats().testUtxos;
    await fundAddress(GENESIS, 500n);

    // The reserved input left the pool and nothing was added back.
    expect(getPoolStats().testUtxos).toBe(before - 1);
    expect(getReservedKeys()).toHaveLength(0);
  });

  test("a single-output tx leaves the pool unchanged", async () => {
    populateFromUtxos([{ txId: "seed", index: 0, value: 1000n }]);
    installOutputDeps([{ value: 1000n }], "fund-tx");

    await fundAddress(GENESIS, 1000n);

    expect(getPoolStats().testUtxos).toBe(0);
    expect(getReservedKeys()).toHaveLength(0);
  });
});

describe("a built tx with no hash", () => {
  test("releases the reservation without re-pooling a possibly-spent input", async () => {
    // The send resolved, so the input may well be spent, but without a hash the
    // spending tx cannot be observed and the release cannot be deferred.
    // Both halves matter: skipping the release strands the reservation forever
    // (rescan and admit both skip reserved keys), and returning it to the pool
    // would hand a spent output to the next request.
    populateFromUtxos([{ txId: "seed", index: 0, value: 1000n }]);
    installOutputDeps([{ value: 500n }, { value: 1000n }], undefined);

    await expect(fundAddress(GENESIS, 500n)).rejects.toThrow(
      "Fund transaction completed without a hash",
    );

    expect(getReservedKeys()).toHaveLength(0);
    expect(getPoolStats().testUtxos).toBe(0);
  });
});

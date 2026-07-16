import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
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

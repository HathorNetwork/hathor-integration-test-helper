import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import { fundAddress, __resetFundStateForTest } from "../../src/fund.service";
import { UtxoStaleError } from "../../src/errors";
import {
  __setFundDepsForTest,
  __resetFundDepsForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/split.service";

/**
 * Regression cover for the stale-UTXO classifier.
 *
 * The classifier previously tested for "already been spent", which wallet-lib
 * never emits — every message below is quoted from the library rather than
 * invented, so a future edit to the predicate that stops matching real
 * wallet-lib output fails here instead of silently disabling stale recovery.
 *
 * Two producers reject a spent input, with different wording:
 *  - the local pre-flight `checkUnspentInput`, whose message is re-thrown as
 *    `Token: ${token}. ${message}` (sendTransaction.js:1305,1442)
 *  - the fullnode, whose message wallet-lib relays verbatim inside SendTxError
 */
const GENESIS = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";

/** Exactly what wallet-lib's local pre-flight throws for a spent input. */
const WALLET_LIB_SPENT =
  "Token: 00. Output [0] of transaction [abc123] is already spent";

/** Representative fullnode phrasing, relayed verbatim by SendTxError. */
const FULLNODE_SPENT =
  "Invalid transaction. At least one of your inputs has already been spent.";

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

let sendAttempts = 0;

/**
 * Install deps whose send throws `error` on the first attempt only, so a
 * correctly-classified stale error produces rescan → retry → success.
 */
function installDeps(error: unknown, failEveryAttempt = false): void {
  const emitter = new EventEmitter();
  const wallet = Object.assign(emitter, {
    async buildTxTemplate() {
      return { hash: `tx-${sendAttempts + 1}`, outputs: [{ value: 1000n }] };
    },
    async getUtxos() {
      return { utxos: [{ tx_id: "rescanned", index: 0, amount: 1000n }] };
    },
    async getTx(id: string) {
      return { id };
    },
  }) as unknown as FundWallet;

  __setFundDepsForTest({
    getGenesisWallet: () => wallet,
    getGenesisAddress: () => GENESIS,
    newTemplateBuilder: fakeBuilder,
    runSendTransaction: async () => {
      sendAttempts += 1;
      if (failEveryAttempt || sendAttempts === 1) throw error;
    },
  });
}

beforeEach(() => {
  sendAttempts = 0;
});

afterEach(() => {
  restoreSharedState();
});

describe("stale-UTXO classification uses wallet-lib's real wording", () => {
  test("recovers from wallet-lib's local 'is already spent' pre-flight error", async () => {
    populateFromUtxos([{ txId: "stale", index: 0, value: 1000n }]);
    installDeps(new Error(WALLET_LIB_SPENT));

    const result = await fundAddress(GENESIS, 500n);

    // Classified as stale → rescan repopulated the pool → the retry succeeded.
    expect(sendAttempts).toBe(2);
    expect(result.txId).toBe("tx-2");
  });

  test("recovers from the fullnode's relayed 'already been spent' message", async () => {
    populateFromUtxos([{ txId: "stale", index: 0, value: 1000n }]);
    installDeps(new Error(FULLNODE_SPENT));

    const result = await fundAddress(GENESIS, 500n);

    expect(sendAttempts).toBe(2);
    expect(result.txId).toBe("tx-2");
  });

  test("finds the spent wording nested in a cause chain", async () => {
    populateFromUtxos([{ txId: "stale", index: 0, value: 1000n }]);
    installDeps(
      new Error("Failed to send transaction", {
        cause: new Error(WALLET_LIB_SPENT),
      }),
    );

    const result = await fundAddress(GENESIS, 500n);

    expect(sendAttempts).toBe(2);
    expect(result.txId).toBe("tx-2");
  });

  test("a persistently stale UTXO ends as UtxoStaleError, not a 500", async () => {
    populateFromUtxos([{ txId: "stale", index: 0, value: 1000n }]);
    installDeps(new Error(WALLET_LIB_SPENT), true);

    await expect(fundAddress(GENESIS, 500n)).rejects.toBeInstanceOf(
      UtxoStaleError,
    );

    // The known-spent output is not handed back to the pool, and nothing leaked.
    expect(getPoolStats().testUtxos).toBe(0);
    expect(getReservedKeys()).toHaveLength(0);
  });

  test("a non-spent wallet-lib rejection is NOT treated as stale", async () => {
    populateFromUtxos([{ txId: "owned", index: 0, value: 1000n }]);
    // wallet-lib's wording when an input isn't the wallet's (sendTransaction.js:1423).
    installDeps(
      new Error("Token: 00. Output [0] of transaction [abc] is not from the wallet"),
      true,
    );

    await expect(fundAddress(GENESIS, 500n)).rejects.not.toBeInstanceOf(
      UtxoStaleError,
    );

    // One attempt only: no rescan, no retry. The UTXO was never spent, so it
    // goes back to the pool rather than being stranded.
    expect(sendAttempts).toBe(1);
    expect(getPoolStats().testUtxos).toBe(1);
    expect(getReservedKeys()).toHaveLength(0);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getPoolStats,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import {
  fundAddress,
  getFundingLifecycleState,
  __resetFundStateForTest,
  __setRefillDelayForTest,
} from "../../src/fund.service";
import { PoolExhaustedError } from "../../src/errors";
import { getMetricsSnapshot, __resetMetricsForTest } from "../../src/metrics";
import {
  __setFundDepsForTest,
  __resetFundDepsForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/split.service";

/**
 * Cover for the refill triggers and the timer body they schedule.
 *
 * A pool at zero has to recover on its own. The success-path trigger cannot do
 * it — while the pool is empty every request fails at the reservation and never
 * reaches that trigger — and the bootstrap split runs once, so the exhausted
 * path must schedule its own refill. These tests drive that path directly.
 *
 * The 1.5s production delay is collapsed to ~0 via __setRefillDelayForTest: at
 * its real value the timer outlives the test that scheduled it and cleanup
 * clears it before the body can run.
 */
const GENESIS = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";

function restoreSharedState(): void {
  __resetFundDepsForTest();
  __resetFundStateForTest();
  __resetMetricsForTest();
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

/** Let scheduled timers and their promise chains settle. */
async function drainTimers(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  __resetMetricsForTest();
  __setRefillDelayForTest(0);
});

afterEach(() => {
  restoreSharedState();
});

describe("a drained pool schedules its own refill", () => {
  test("POOL_EXHAUSTED splits a large output and repopulates the pool", async () => {
    // Empty pool, but the wallet holds a large output the refill can split.
    const emitter = new EventEmitter();
    const wallet = Object.assign(emitter, {
      async getUtxos() {
        return { utxos: [{ tx_id: "big", index: 0, amount: 5000n }] };
      },
      async buildTxTemplate() {
        return {
          hash: "split-tx",
          outputs: [{ value: 1000n }, { value: 1000n }, { value: 2900n }],
        };
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

    populateFromUtxos([]);
    expect(getPoolStats().testUtxos).toBe(0);

    await expect(fundAddress(GENESIS, 500n)).rejects.toBeInstanceOf(
      PoolExhaustedError,
    );

    // The failing request scheduled the refill on its way out.
    expect(getFundingLifecycleState().refillScheduled).toBe(true);

    await drainTimers();

    // The timer body ran: the split's two test-sized outputs are now pooled,
    // so the next request can succeed where this one could not.
    expect(getPoolStats().testUtxos).toBe(2);
    expect(getFundingLifecycleState().lastRefillError).toBeNull();
    expect(getFundingLifecycleState().lastRefillAt).not.toBeNull();
  });

  test("a refill failing in the wallet query is counted and surfaced", async () => {
    // The failure lands in reserveLargeFromWallet, before splitUtxo is reached —
    // the case recordSplit(false) never sees.
    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async getUtxos() {
            throw new Error("wallet unreachable");
          },
        }) as unknown as FundWallet,
      getGenesisAddress: () => GENESIS,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {},
    });

    populateFromUtxos([]);
    await expect(fundAddress(GENESIS, 500n)).rejects.toBeInstanceOf(
      PoolExhaustedError,
    );
    await drainTimers();

    const snapshot = getMetricsSnapshot();
    expect(snapshot.refillFailures).toBe(1);
    // splitUtxo was never entered, so the split counters stay untouched.
    expect(snapshot.splitFailures).toBe(0);

    const lifecycle = getFundingLifecycleState();
    expect(lifecycle.lastRefillError).toBe("wallet unreachable");
    expect(lifecycle.lastRefillAt).not.toBeNull();
  });

  test("a refill with no large output to split does not report success", async () => {
    // The wallet holds nothing big enough to split, so the pool cannot refill.
    // That must not read as a completed refill on /status: a pool stuck at zero
    // because genesis has no large output is precisely what an operator needs
    // to see, and it is indistinguishable from a healthy idle refill otherwise.
    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async getUtxos() {
            return { utxos: [] };
          },
        }) as unknown as FundWallet,
      getGenesisAddress: () => GENESIS,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {},
    });

    populateFromUtxos([]);
    await expect(fundAddress(GENESIS, 500n)).rejects.toBeInstanceOf(
      PoolExhaustedError,
    );
    await drainTimers();

    expect(getPoolStats().testUtxos).toBe(0);
    const lifecycle = getFundingLifecycleState();
    expect(lifecycle.lastRefillError).not.toBeNull();
    expect(lifecycle.lastRefillError).toContain("no large output");
    expect(getMetricsSnapshot().refillFailures).toBe(1);
  });

  test("a successful fund below the threshold schedules a refill", async () => {
    // The original trigger, still load-bearing: a pool that dips below
    // REFILL_THRESHOLD tops itself up without waiting to hit zero first.
    const emitter = new EventEmitter();
    const wallet = Object.assign(emitter, {
      async buildTxTemplate() {
        return { hash: "fund-tx", outputs: [{ value: 500n }] };
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

    populateFromUtxos([{ txId: "seed", index: 0, value: 1000n }]);
    expect(getFundingLifecycleState().refillScheduled).toBe(false);

    const result = await fundAddress(GENESIS, 500n);
    expect(result.txId).toBe("fund-tx");

    expect(getFundingLifecycleState().refillScheduled).toBe(true);
  });

  test("a second trigger is absorbed while one refill is already scheduled", async () => {
    let queries = 0;
    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async getUtxos() {
            queries += 1;
            return { utxos: [] };
          },
        }) as unknown as FundWallet,
      getGenesisAddress: () => GENESIS,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {},
    });

    populateFromUtxos([]);
    // Three exhausted requests, but only one refill on the clock between them.
    await expect(fundAddress(GENESIS, 500n)).rejects.toBeInstanceOf(
      PoolExhaustedError,
    );
    await expect(fundAddress(GENESIS, 500n)).rejects.toBeInstanceOf(
      PoolExhaustedError,
    );
    await expect(fundAddress(GENESIS, 500n)).rejects.toBeInstanceOf(
      PoolExhaustedError,
    );
    await drainTimers();

    expect(queries).toBe(1);
  });
});

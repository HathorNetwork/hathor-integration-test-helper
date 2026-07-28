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
  rescanUtxoPool,
  getFundingLifecycleState,
  __resetFundStateForTest,
} from "../../src/fund.service";
import {
  __setFundDepsForTest,
  __resetFundDepsForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/split.service";

/**
 * The service's reason for existing: many concurrent tests funding at once,
 * race-free and without queueing behind each other.
 *
 * Standard /fund requests spend pre-existing pool UTXOs, so they are siblings
 * with no ordering constraint between them — dozens may legitimately land in
 * the same second. Only transactions that are *parents of one another* need
 * inter-tx spacing (a Hathor tx timestamp must strictly exceed every parent's,
 * and fullnode timestamps have 1-second granularity). That spacing therefore
 * belongs to the split — whose parent is the fund tx that triggered its refill
 * — and must never sit on the request path.
 *
 * This is a guard against reintroducing a delay there. It has previously been
 * got wrong in a way unit tests did not catch: a 1s sleep at the head of
 * `rescanUtxoPool`, which every incoming request parks on, turned one stale
 * UTXO into a seconds-long stall for every concurrent caller.
 */
const GENESIS = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";

/**
 * Generous enough to absorb a slow CI box, tight enough that any *second*-scale
 * delay on the request path fails it: the smallest such delay in this subsystem
 * is 1000ms, and these requests run concurrently, so a per-request sleep shows
 * up as roughly its own duration, not 60×.
 */
const BUDGET_MS = 500;
const BURST = 60;

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

beforeEach(() => {
  let issued = 0;
  const emitter = new EventEmitter();
  const wallet = Object.assign(emitter, {
    async buildTxTemplate() {
      issued += 1;
      return { hash: `tx-${issued}`, outputs: [{ value: 500n }] };
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
});

afterEach(() => {
  restoreSharedState();
});

describe("concurrent /fund requests are not serialized", () => {
  test(`${BURST} simultaneous funds settle well inside one second`, async () => {
    populateFromUtxos(
      Array.from({ length: BURST }, (_, i) => ({
        txId: `pooled-${i}`,
        index: 0,
        value: 1000n,
      })),
    );

    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: BURST }, () => fundAddress(GENESIS, 500n)),
    );
    const elapsedMs = performance.now() - started;

    // Each request won its own UTXO: the reservation invariant held under a
    // simultaneous burst, with no two requests sharing a transaction.
    expect(new Set(results.map((r) => r.txId)).size).toBe(BURST);
    expect(getPoolStats().testUtxos).toBe(0);
    expect(getReservedKeys()).toHaveLength(0);

    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  test("a request parked on an in-flight rescan is not stalled", async () => {
    // The precise shape of the original defect: fundAddress parks every
    // incoming request on `rescanInProgress`, so any delay inside the rescan is
    // paid by every concurrent caller, not just the one that went stale. The
    // rescan only reads the wallet, so it must stay sub-second.
    //
    // This wallet reports UTXOs, so the rescan repopulates rather than emptying
    // the pool and the parked requests can go on to reserve.
    let issued = 0;
    const emitter = new EventEmitter();
    const wallet = Object.assign(emitter, {
      async buildTxTemplate() {
        issued += 1;
        return { hash: `rescan-tx-${issued}`, outputs: [{ value: 500n }] };
      },
      async getUtxos() {
        return {
          utxos: Array.from({ length: 10 }, (_, i) => ({
            tx_id: `rescanned-${i}`,
            index: 0,
            amount: 1000n,
          })),
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

    populateFromUtxos([{ txId: "pooled-0", index: 0, value: 1000n }]);

    const started = performance.now();
    // Kick off a rescan without awaiting it, then immediately issue funds — they
    // will find `rescanInProgress` set and wait on it before reserving.
    const rescan = rescanUtxoPool();
    const funds = Promise.all(
      Array.from({ length: 5 }, () => fundAddress(GENESIS, 500n)),
    );

    await rescan;
    const results = await funds;
    const elapsedMs = performance.now() - started;

    expect(results).toHaveLength(5);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  test("the refill a burst triggers is scheduled, never awaited", async () => {
    // The pool ends far below REFILL_THRESHOLD, so every success calls
    // triggerBackgroundRefill(). The requests must return without waiting out
    // its inter-tx delay — that delay protects the split, not the fund.
    populateFromUtxos(
      Array.from({ length: 5 }, (_, i) => ({
        txId: `pooled-${i}`,
        index: 0,
        value: 1000n,
      })),
    );

    const started = performance.now();
    await Promise.all(
      Array.from({ length: 5 }, () => fundAddress(GENESIS, 500n)),
    );
    const elapsedMs = performance.now() - started;

    expect(getFundingLifecycleState().refillScheduled).toBe(true);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });
});

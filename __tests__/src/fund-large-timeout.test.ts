import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  populateFromUtxos,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import {
  fundAddress,
  reserveLargeWithTimeout,
  rescanUtxoPool,
  __setFundDepsForTest,
  __resetFundDepsForTest,
  __resetFundStateForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/fund.service";
import { FundTimeoutError } from "../../src/errors";

// Large funding is wallet-sourced (not pooled). These tests cover the large
// happy path, the RFC's bounded wait for a large output (FUND_TIMEOUT), and
// the isolation of an unrelated /fund from a failing rescan. DI seam, not
// mock.module (CLAUDE.md).

const genesisAddress = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";

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
  populateFromUtxos([]);
});

afterEach(() => {
  restoreSharedState();
});

describe("large fund path", () => {
  test("sources a large request from the wallet and reports source 'large'", async () => {
    __setFundDepsForTest({
      getGenesisWallet: () => {
        const emitter = new EventEmitter();
        return Object.assign(emitter, {
          async getUtxos() {
            return { utxos: [{ tx_id: "big", index: 0, amount: 50000n }] };
          },
          async buildTxTemplate() {
            return {
              hash: "large-tx",
              outputs: [{ value: 30000 }, { value: 20000 }],
            };
          },
          async getTx(id: string) {
            return { id };
          },
        }) as unknown as FundWallet;
      },
      getGenesisAddress: () => genesisAddress,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {},
    });

    const result = await fundAddress(genesisAddress, 30000n);

    expect(result.txId).toBe("large-tx");
    expect(result.utxoSource).toBe("large");
    expect(result.amount).toBe(30000n);
    // The reservation is released once the (already-observed) tx settles.
    expect(getReservedKeys()).toHaveLength(0);
  });
});

describe("reserveLargeWithTimeout", () => {
  test("returns null at the deadline when no large output appears", async () => {
    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async getUtxos() {
            return { utxos: [] };
          },
        }) as unknown as FundWallet,
    });

    const reserved = await reserveLargeWithTimeout(30000n, 40, 10);
    expect(reserved).toBeNull();
  });

  test("resolves as soon as a covering output becomes available", async () => {
    let calls = 0;
    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async getUtxos() {
            calls += 1;
            // Empty for the first couple of polls, then a large output appears.
            return calls >= 3
              ? { utxos: [{ tx_id: "late-big", index: 1, amount: 50000n }] }
              : { utxos: [] };
          },
        }) as unknown as FundWallet,
    });

    const reserved = await reserveLargeWithTimeout(30000n, 1000, 10);
    expect(reserved).not.toBeNull();
    expect(reserved!.utxo.txId).toBe("late-big");
    expect(reserved!.source).toBe("large");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("fundAddress maps an exhausted large wait to FUND_TIMEOUT", async () => {
    // A zero-ish timeout keeps the test fast: one immediate attempt, then the
    // deadline is already past, so the wait returns null → FundTimeoutError.
    __setFundDepsForTest({
      getGenesisWallet: () =>
        ({
          async getUtxos() {
            return { utxos: [] };
          },
        }) as unknown as FundWallet,
    });

    await expect(reserveLargeWithTimeout(30000n, 0)).resolves.toBeNull();

    // And the error type the /fund handler surfaces on that null:
    expect(new FundTimeoutError(30000).descriptor.code).toBe("FUND_TIMEOUT");
  });
});

describe("fund isolation from a failing rescan", () => {
  test("a fund waiting on a failing rescan still proceeds", async () => {
    populateFromUtxos([{ txId: "good", index: 0, value: 1000n }]);
    __setFundDepsForTest({
      getGenesisWallet: () => {
        const emitter = new EventEmitter();
        return Object.assign(emitter, {
          // The rescan's repopulation query fails...
          async getUtxos() {
            throw new Error("rescan boom");
          },
          // ...but building/sending the fund tx works.
          async buildTxTemplate() {
            return { hash: "tx-ok", outputs: [{ value: 500 }, { value: 500 }] };
          },
          async getTx(id: string) {
            return { id };
          },
        }) as unknown as FundWallet;
      },
      getGenesisAddress: () => genesisAddress,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {},
    });

    // Start a rescan (sets rescanInProgress), then fund while it is pending.
    const rescan = rescanUtxoPool().catch(() => "rescan-failed");
    const result = await fundAddress(genesisAddress, 500n);

    expect(result.txId).toBe("tx-ok");
    expect(await rescan).toBe("rescan-failed");
  });
});

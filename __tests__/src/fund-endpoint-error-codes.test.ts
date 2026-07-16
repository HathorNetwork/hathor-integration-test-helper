import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  populateFromUtxos,
  getReservedKeys,
  releaseReservation,
} from "../../src/utxo-pool.service";
import { generateSimpleWallet } from "../../src/wallet.service";
import { __setGenesisStateForTest } from "../../src/genesis.service";
import {
  __setFundDepsForTest,
  __resetFundDepsForTest,
  __resetFundStateForTest,
  __setSplitInProgressForTest,
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/fund.service";
import { handleFund } from "../../src/routes";

// Drives the REAL fund.service through the route (DI, not mock.module) to
// verify handleFund maps a ServiceError to its RFC response and an unexpected
// throw to a 500. The exhaustive code→status/retryable table is covered by
// errors.test.ts; here we check the route's two branches with representatives.

const validAddress = generateSimpleWallet().addresses[0]!;
const genesisAddress = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";

function fakeWallet(): FundWallet {
  return {
    async buildTxTemplate() {
      return { hash: "tx", outputs: [{ value: 500 }, { value: 500 }] };
    },
    async getTx(id: string) {
      return { id };
    },
    on() {},
    off() {},
  } as unknown as FundWallet;
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

function fundReq(body: unknown): Request {
  return new Request("http://localhost/fund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __setGenesisStateForTest({ ready: true, address: genesisAddress });
  __setFundDepsForTest({
    getGenesisWallet: fakeWallet,
    getGenesisAddress: () => genesisAddress,
    newTemplateBuilder: fakeBuilder,
    runSendTransaction: async () => {},
  });
  populateFromUtxos([]);
});

afterEach(() => {
  __setSplitInProgressForTest(false);
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
  // Clear the funded override too: __setGenesisStateForTest only mutates
  // supplied fields, so leaving it set makes later readiness tests order-dependent.
  __setGenesisStateForTest({ ready: false, address: null, funded: null });
});

describe("POST /fund maps errors to RFC responses", () => {
  test("empty pool → 409 POOL_EXHAUSTED retryable", async () => {
    populateFromUtxos([]); // no test-sized UTXOs
    const res = await handleFund(fundReq({ address: validAddress, amount: 100 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("POOL_EXHAUSTED");
    expect(body.retryable).toBe(true);
  });

  test("empty pool mid-split → 409 SPLIT_IN_PROGRESS retryable", async () => {
    populateFromUtxos([]);
    __setSplitInProgressForTest(true);
    const res = await handleFund(fundReq({ address: validAddress, amount: 100 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("SPLIT_IN_PROGRESS");
    expect(body.retryable).toBe(true);
  });

  test("unexpected send failure → 500 with retryable:false", async () => {
    populateFromUtxos([{ txId: "good", index: 0, value: 1000n }]);
    __setFundDepsForTest({
      getGenesisWallet: fakeWallet,
      getGenesisAddress: () => genesisAddress,
      newTemplateBuilder: fakeBuilder,
      runSendTransaction: async () => {
        throw new Error("kaboom");
      },
    });
    const res = await handleFund(fundReq({ address: validAddress, amount: 500 }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.retryable).toBe(false);
  });
});

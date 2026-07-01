import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";
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
  type FundTemplateBuilder,
  type FundWallet,
} from "../../src/fund.service";
import { handleStatus, handleFund, handleMetrics } from "../../src/routes";

// End-to-end route tests driving the REAL handlers + fund.service through the
// DI seam (no mock.module — it leaks process-globally across Bun test files).

const validAddress = generateSimpleWallet().addresses[0]!;
const genesisAddress = "WjS6pizxsgNQypgYvGQ8jDB9JMS4P9nVgk";

function fakeWallet(): FundWallet {
  return {
    async buildTxTemplate() {
      return { hash: "fund-tx", outputs: [{ value: 500 }, { value: 500 }] };
    },
    async *getAvailableUtxos() {},
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

function fundRequest(body: unknown): Request {
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
  populateFromUtxos([
    { txId: "test-tx-1", index: 0, value: 1000n },
    { txId: "test-tx-2", index: 0, value: 1000n },
    { txId: "large-tx", index: 0, value: 500000n },
  ]);
});

afterEach(() => {
  // Restore shared singletons so later files (routes-readiness) see a
  // not-ready genesis + empty pool.
  __resetFundDepsForTest();
  __resetFundStateForTest();
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
  __setGenesisStateForTest({ ready: false, address: null });
});

describe("GET /status when funding is up", () => {
  test("reports ready with pool stats, genesis address, and funding block", async () => {
    const res = handleStatus(new Request("http://localhost/status"));
    expect(res.status).toBe(200);

    const body = JSONBigInt.parse(await res.text());
    expect(body.ready).toBe(true);
    expect(body.readyReason).toBe("ready");
    expect(body.genesisAddress).toBe(genesisAddress);
    expect(typeof body.testUtxos).toBe("number");
    expect(body.funding).toHaveProperty("splitInProgress");
  });
});

describe("POST /fund validation", () => {
  test("400 INVALID_REQUEST when address missing", async () => {
    const res = await handleFund(fundRequest({ amount: 100 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });

  test("400 INVALID_REQUEST when address is empty", async () => {
    const res = await handleFund(fundRequest({ address: "", amount: 100 }));
    expect(res.status).toBe(400);
  });

  test("400 INVALID_REQUEST when amount is negative", async () => {
    const res = await handleFund(fundRequest({ address: validAddress, amount: -10 }));
    expect(res.status).toBe(400);
  });

  test("400 INVALID_REQUEST for a non-JSON content type", async () => {
    const res = await handleFund(
      new Request("http://localhost/fund", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ address: validAddress, amount: 100 }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /fund happy path and readiness", () => {
  test("200 with {txId, amount, utxoSource} on a valid request", async () => {
    const res = await handleFund(fundRequest({ address: validAddress, amount: 500 }));
    expect(res.status).toBe(200);
    const body = JSONBigInt.parse(await res.text());
    expect(body).toHaveProperty("txId", "fund-tx");
    // JSONBigInt round-trips small bigints back to plain JS numbers.
    expect(body).toHaveProperty("amount", 500);
    expect(body.utxoSource).toBe("test");
  });

  test("503 SERVICE_NOT_READY when genesis has not synced", async () => {
    __setGenesisStateForTest({ ready: false, address: null });
    const res = await handleFund(fundRequest({ address: validAddress, amount: 100 }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("SERVICE_NOT_READY");
    expect(body.retryable).toBe(true);
  });
});

describe("GET /metrics", () => {
  test("returns the counter snapshot shape", async () => {
    const res = handleMetrics(new Request("http://localhost/metrics"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("routes");
    expect(typeof body.fundCount).toBe("number");
    expect(typeof body.splitCount).toBe("number");
  });
});

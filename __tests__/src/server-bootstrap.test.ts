import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { startTestServer } from "../../src/test-server";
import { createRoutes } from "../../src/app";
import {
  initializeCache,
  __setGeneratorForTest,
  __resetCacheForTest,
} from "../../src/wallet.cache";
import type { SimpleWallet } from "../../src/wallet.service";

/**
 * End-to-end smoke against a real Bun.serve instance. We deliberately
 * stub the wallet generator so the cache fills instantly — the real
 * BIP39 derivation is covered by `wallet-service.test.ts`. Here we are
 * verifying that bootstrap (initializeCache + Bun.serve + createRoutes)
 * works as a unit and that the wire-level contract holds end-to-end.
 */

function stubWallet(): SimpleWallet {
  return {
    words: Array.from({ length: 24 }, (_, i) => `w${i}`).join(" "),
    addresses: Array.from({ length: 22 }, (_, i) => `addr-${i}`),
  };
}

let server: ReturnType<typeof startTestServer>;
let baseUrl: string;

beforeAll(() => {
  __resetCacheForTest();
  __setGeneratorForTest(stubWallet);
  initializeCache();
  server = startTestServer({ port: 0, routes: createRoutes() });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
  __setGeneratorForTest(null);
  __resetCacheForTest();
});

describe("server bootstrap end-to-end", () => {
  test("GET /live → {live: true} with x-request-id echoed", async () => {
    const res = await fetch(`${baseUrl}/live`, {
      headers: { "x-request-id": "e2e-1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("e2e-1");
    expect(await res.json()).toEqual({ live: true });
  });

  test("GET /simpleWallet → 24-word seed + 22 addresses + retrieveTimeMs", async () => {
    const res = await fetch(`${baseUrl}/simpleWallet`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      words: string;
      addresses: string[];
      retrieveTimeMs: number;
    };
    expect(body.words.split(" ")).toHaveLength(24);
    expect(body.addresses).toHaveLength(22);
    expect(typeof body.retrieveTimeMs).toBe("number");
  });

  test("GET /multisigWallet happy path → wallets array", async () => {
    const res = await fetch(
      `${baseUrl}/multisigWallet?participants=2&numSignatures=2`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wallets: unknown[] };
    expect(body.wallets).toHaveLength(2);
  });

  test("GET /multisigWallet bad params → 400 INVALID_REQUEST", async () => {
    const res = await fetch(
      `${baseUrl}/multisigWallet?participants=1&numSignatures=2`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });

  test("unknown route → Bun.serve 404 (no observability wrap, but no crash)", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("response carries x-request-id when none provided", async () => {
    const res = await fetch(`${baseUrl}/live`);
    expect(res.status).toBe(200);
    const id = res.headers.get("x-request-id");
    expect(id).toBeTypeOf("string");
    expect(id!.length).toBeGreaterThan(0);
  });
});

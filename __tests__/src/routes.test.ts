import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  handleSimpleWallet,
  handleMultisigWallet,
  handleLive,
} from "../../src/routes";
import {
  initializeCache,
  __setGeneratorForTest,
  __resetCacheForTest,
} from "../../src/wallet.cache";
import type { SimpleWallet } from "../../src/wallet.service";

function get(url: string): Request {
  return new Request(url, { method: "GET" });
}

function stubWallet(): SimpleWallet {
  return {
    words: Array.from({ length: 24 }, (_, i) => `w${i}`).join(" "),
    addresses: Array.from({ length: 22 }, (_, i) => `addr-${i}`),
  };
}

beforeAll(() => {
  // Prevent the routes test from paying real BIP39 generation cost.
  __resetCacheForTest();
  __setGeneratorForTest(stubWallet);
  initializeCache();
});

// bun:test runs all unit files in a single process. Restore the real
// generator and clear the cache so later suites aren't order-dependent
// on this file's setup.
afterAll(() => {
  __setGeneratorForTest(null);
  __resetCacheForTest();
});

describe("handleLive", () => {
  test("returns {live: true} with status 200", async () => {
    const res = handleLive(get("http://x/live"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
  });
});

describe("handleSimpleWallet", () => {
  test("returns 24-word seed + 22 addresses + numeric retrieveTimeMs", async () => {
    const res = handleSimpleWallet(get("http://x/simpleWallet"));
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
});

describe("handleMultisigWallet validation", () => {
  test("missing both params → 400 INVALID_REQUEST", async () => {
    const res = handleMultisigWallet(get("http://x/multisigWallet"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.retryable).toBe(false);
  });

  test("missing numSignatures → 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=2"),
    );
    expect(res.status).toBe(400);
  });

  test("NaN values → 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=foo&numSignatures=2"),
    );
    expect(res.status).toBe(400);
  });

  test("trailing-garbage values (parseInt truncation trap) → 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=2abc&numSignatures=2"),
    );
    expect(res.status).toBe(400);
  });

  test("decimal values → 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=2.5&numSignatures=1"),
    );
    expect(res.status).toBe(400);
  });

  test("participants < 1 → 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=0&numSignatures=1"),
    );
    expect(res.status).toBe(400);
  });

  test("numSignatures < 1 → 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=2&numSignatures=0"),
    );
    expect(res.status).toBe(400);
  });

  test("numSignatures > participants → 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=2&numSignatures=3"),
    );
    expect(res.status).toBe(400);
  });
});

describe("handleMultisigWallet happy path", () => {
  test("returns {wallets, retrieveTimeMs} with one entry per participant", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=2&numSignatures=2"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wallets: { addresses: string[]; multisigDebugData: { pubkeys: string[] } }[];
      retrieveTimeMs: number;
    };
    expect(body.wallets).toHaveLength(2);
    expect(body.wallets[0]!.addresses).toEqual(body.wallets[1]!.addresses);
    expect(typeof body.retrieveTimeMs).toBe("number");
  });
});

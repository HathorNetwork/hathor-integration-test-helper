# PR2 — Wallet endpoints + server skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /simpleWallet`, `GET /multisigWallet`, `GET /live`
end-to-end through the X-Test-Name observability pipeline, plus a
FIFO wallet cache, signal handlers, and request metrics.

**Architecture:** Bun.serve with a typed route map; each handler is
wrapped by `withObservability` which binds `X-Test-Name` into
AsyncLocalStorage, propagates `x-request-id`, records latency, and
catches any unexpected throw as `500 INTERNAL_ERROR`. Domain
validation errors (`InvalidRequestError`) are returned by the
handler directly, not thrown. Wallet generation is amortized via a
FIFO cache refilled asynchronously with hardened error handling.

**Tech Stack:** Bun (runtime + test runner), `@hathor/wallet-lib`
3.0.1 (BIP39 seeds, address derivation), TypeScript strict mode.

**Spec:** `docs/superpowers/specs/2026-05-14-pr2-wallet-endpoints-design.md`

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/errors.ts` | Modify | Add `INTERNAL_ERROR` to union + table |
| `src/wallet.service.ts` | Create | `generateSimpleWallet`, `generateMultisigWallet` |
| `src/wallet.cache.ts` | Create | FIFO cache, hardened refill |
| `src/signal-handlers.ts` | Create | Graceful shutdown w/ configurable drain |
| `src/metrics.ts` | Create | Request counter + latency snapshot (subset) |
| `src/routes.ts` | Create | Three handlers |
| `src/app.ts` | Create | `withObservability`, `createRoutes` |
| `index.ts` | Modify | Wire `initializeCache`, `Bun.serve`, signal handlers |
| `__tests__/src/wallet-service.test.ts` | Create | Unit |
| `__tests__/src/wallet-cache.test.ts` | Create | Unit (incl. refill failure) |
| `__tests__/src/signal-handlers.test.ts` | Create | Unit |
| `__tests__/src/metrics.test.ts` | Create | Unit |
| `__tests__/src/routes.test.ts` | Create | Unit (handlers) |
| `__tests__/src/app-test-name.test.ts` | Create | Pipeline integration |
| `__tests__/index.test.ts` | Create | End-to-end against real Bun.serve |

---

### Task 1: Add `INTERNAL_ERROR` to ErrorCode union

**Files:**
- Modify: `src/errors.ts`
- Test: `__tests__/src/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/src/errors.test.ts`:

```ts
import { ServiceError } from "../../src/errors";

test("INTERNAL_ERROR descriptor: 500, not retryable", () => {
  const err = new ServiceError("INTERNAL_ERROR", "boom");
  expect(err.descriptor).toEqual({
    code: "INTERNAL_ERROR",
    status: 500,
    retryable: false,
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (`bun test __tests__/src/errors.test.ts`). Failure: `"INTERNAL_ERROR"` not assignable to `ErrorCode`.

- [ ] **Step 3: Add `INTERNAL_ERROR` to union and table in `src/errors.ts`**

```ts
export type ErrorCode =
  | "POOL_EXHAUSTED"
  | "SPLIT_IN_PROGRESS"
  | "UTXO_STALE"
  | "FUND_TIMEOUT"
  | "INVALID_REQUEST"
  | "SERVICE_NOT_READY"
  | "INTERNAL_ERROR";

const ERROR_TABLE = {
  POOL_EXHAUSTED:    { status: 409, retryable: true  },
  SPLIT_IN_PROGRESS: { status: 409, retryable: true  },
  UTXO_STALE:        { status: 409, retryable: true  },
  FUND_TIMEOUT:      { status: 409, retryable: true  },
  SERVICE_NOT_READY: { status: 503, retryable: true  },
  INVALID_REQUEST:   { status: 400, retryable: false },
  INTERNAL_ERROR:    { status: 500, retryable: false },
} as const satisfies Record<ErrorCode, { status: number; retryable: boolean }>;
```

- [ ] **Step 4: Run test — expect PASS** (`bun test __tests__/src/errors.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts __tests__/src/errors.test.ts
git commit --no-gpg-sign -m "feat(errors): add INTERNAL_ERROR code"
```

---

### Task 2: `wallet.service.ts` — simple wallet

**Files:**
- Create: `src/wallet.service.ts`
- Test: `__tests__/src/wallet-service.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, test, expect } from "bun:test";
import { generateSimpleWallet } from "../../src/wallet.service";
import { isValidHathorAddress } from "../../src/address";

describe("generateSimpleWallet", () => {
  test("returns 24 words and 22 addresses", () => {
    const w = generateSimpleWallet();
    expect(w.words.split(" ")).toHaveLength(24);
    expect(w.addresses).toHaveLength(22);
  });

  test("all addresses validate on the configured network", () => {
    const w = generateSimpleWallet();
    for (const addr of w.addresses) {
      expect(isValidHathorAddress(addr)).toBe(true);
    }
  });

  test("two calls produce different seeds", () => {
    const a = generateSimpleWallet();
    const b = generateSimpleWallet();
    expect(a.words).not.toBe(b.words);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Create `src/wallet.service.ts`**

```ts
import hathorLib from "@hathor/wallet-lib";
import { config } from "./config";

const { walletUtils, addressUtils, config: hathorConfig } = hathorLib;
hathorConfig.setNetwork(config.NETWORK);

export interface SimpleWallet {
  words: string;
  addresses: string[];
}

export function generateSimpleWallet(): SimpleWallet {
  const words = walletUtils.generateWalletWords();
  const xpub = walletUtils.getXPubKeyFromSeed(words, {
    accountDerivationIndex: "0'/0",
    networkName: config.NETWORK,
  });
  const addresses: string[] = [];
  for (let i = 0; i < config.ADDRESS_COUNT; i++) {
    const info = addressUtils.deriveAddressFromXPubP2PKH(
      xpub,
      i,
      config.NETWORK,
    );
    addresses.push(info.base58);
  }
  return { words, addresses };
}
```

- [ ] **Step 4: Run — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src/wallet.service.ts __tests__/src/wallet-service.test.ts
git commit --no-gpg-sign -m "feat: add generateSimpleWallet"
```

---

### Task 3: `wallet.service.ts` — multisig wallet

- [ ] **Step 1: Append failing tests** to `__tests__/src/wallet-service.test.ts`

```ts
import { generateMultisigWallet } from "../../src/wallet.service";

describe("generateMultisigWallet", () => {
  test("returns one wallet per participant", () => {
    const w = generateMultisigWallet(3, 2);
    expect(w).toHaveLength(3);
  });

  test("all participants share the same addresses", () => {
    const w = generateMultisigWallet(3, 2);
    expect(w[0]!.addresses).toEqual(w[1]!.addresses);
    expect(w[1]!.addresses).toEqual(w[2]!.addresses);
  });

  test("pubkeys are sorted lexicographically", () => {
    const w = generateMultisigWallet(3, 2);
    const sorted = [...w[0]!.multisigDebugData.pubkeys].sort();
    expect(w[0]!.multisigDebugData.pubkeys).toEqual(sorted);
  });

  test("multisigDebugData lists all participants", () => {
    const w = generateMultisigWallet(3, 2);
    expect(w[0]!.multisigDebugData.total).toBe(3);
    expect(w[0]!.multisigDebugData.numSignatures).toBe(2);
    expect(w[0]!.multisigDebugData.words).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Append to `src/wallet.service.ts`**

```ts
export interface MultisigDebugData {
  words: string[];
  total: number;
  numSignatures: number;
  pubkeys: string[];
}

export interface MultisigWallet {
  words: string;
  addresses: string[];
  multisigDebugData: MultisigDebugData;
}

export function generateMultisigWallet(
  participants: number,
  numSignatures: number,
): MultisigWallet[] {
  const allWords: string[] = [];
  const pubkeys: string[] = [];

  for (let i = 0; i < participants; i++) {
    const words = walletUtils.generateWalletWords();
    allWords.push(words);
    const xpub = walletUtils.getMultiSigXPubFromWords(words, {
      networkName: config.NETWORK,
    });
    pubkeys.push(xpub);
  }

  const sortedPubkeys = [...pubkeys].sort();
  const multisigData = { pubkeys: sortedPubkeys, numSignatures };

  const sharedAddresses: string[] = [];
  for (let i = 0; i < config.ADDRESS_COUNT; i++) {
    const info = addressUtils.deriveAddressFromDataP2SH(
      multisigData,
      i,
      config.NETWORK,
    );
    sharedAddresses.push(info.base58);
  }

  return allWords.map((words) => ({
    words,
    addresses: sharedAddresses,
    multisigDebugData: {
      words: allWords,
      total: participants,
      numSignatures,
      pubkeys: sortedPubkeys,
    },
  }));
}
```

- [ ] **Step 4: Run — expect PASS**. Commit:

```bash
git add src/wallet.service.ts __tests__/src/wallet-service.test.ts
git commit --no-gpg-sign -m "feat: add generateMultisigWallet"
```

---

### Task 4: `wallet.cache.ts` — FIFO + hardened refill

**Files:**
- Create: `src/wallet.cache.ts`
- Test: `__tests__/src/wallet-cache.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("wallet.cache", () => {
  beforeEach(() => {
    // Each test imports fresh; resetting module registry isn't trivial
    // in bun. Tests are designed to be order-independent on shared state.
  });

  test("initializeCache + getSimpleWalletFromCache returns wallets", async () => {
    const { initializeCache, getSimpleWalletFromCache, getCacheSize } =
      await import("../../src/wallet.cache");
    initializeCache();
    expect(getCacheSize()).toBeGreaterThan(0);
    const w = getSimpleWalletFromCache();
    expect(w.words.split(" ")).toHaveLength(24);
  });

  test("on generateSimpleWallet failure: clears isRefilling, schedules retry, logs", async () => {
    // Force generateSimpleWallet to throw on the first refill attempt,
    // then succeed.
    let calls = 0;
    mock.module("../../src/wallet.service", () => ({
      generateSimpleWallet: () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { words: "w".repeat(24 * 2 - 1), addresses: [] };
      },
    }));
    const logger = await import("../../src/logger");
    const errSpy = mock(() => {});
    const original = logger.logger.error;
    logger.logger.error = errSpy;
    try {
      const { getSimpleWalletFromCache } = await import("../../src/wallet.cache");
      // Drain the pre-filled cache so refill is triggered.
      for (let i = 0; i < 20; i++) getSimpleWalletFromCache();
      // Yield for setImmediate chains
      await new Promise((r) => setTimeout(r, 50));
      const events = errSpy.mock.calls.map((c) => (c[0] as { event: string }).event);
      expect(events).toContain("wallet_cache.refill_failed");
      expect(calls).toBeGreaterThan(1); // retry happened
    } finally {
      logger.logger.error = original;
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Create `src/wallet.cache.ts`**

```ts
import { generateSimpleWallet, type SimpleWallet } from "./wallet.service";
import { config } from "./config";
import { logger } from "./logger";

const simpleWalletCache: SimpleWallet[] = [];
let isRefilling = false;

function fillCacheSync(): void {
  while (simpleWalletCache.length < config.SIMPLE_WALLET_CACHE_SIZE) {
    simpleWalletCache.push(generateSimpleWallet());
  }
}

function refillCacheAsync(): void {
  if (isRefilling) return;
  if (simpleWalletCache.length >= config.SIMPLE_WALLET_CACHE_SIZE) return;
  isRefilling = true;

  const refillOne = () => {
    if (simpleWalletCache.length >= config.SIMPLE_WALLET_CACHE_SIZE) {
      isRefilling = false;
      return;
    }
    try {
      simpleWalletCache.push(generateSimpleWallet());
      setImmediate(refillOne);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({
        event: "wallet_cache.refill_failed",
        meta: { error: message },
      });
      isRefilling = false;
      // Schedule a single retry to preserve self-healing without a
      // hot error loop. The next iteration's own try/catch will gate
      // further retries.
      setImmediate(refillOne);
    }
  };

  setImmediate(refillOne);
}

export function getSimpleWalletFromCache(): SimpleWallet {
  const w = simpleWalletCache.shift();
  refillCacheAsync();
  return w ?? generateSimpleWallet();
}

export function getCacheSize(): number {
  return simpleWalletCache.length;
}

export function initializeCache(): void {
  logger.info({
    event: "wallet_cache.initializing",
    meta: { size: config.SIMPLE_WALLET_CACHE_SIZE },
  });
  const start = performance.now();
  fillCacheSync();
  logger.info({
    event: "wallet_cache.ready",
    meta: {
      size: simpleWalletCache.length,
      elapsedMs: Number((performance.now() - start).toFixed(2)),
    },
  });
}
```

- [ ] **Step 4: Run — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src/wallet.cache.ts __tests__/src/wallet-cache.test.ts
git commit --no-gpg-sign -m "feat: add wallet cache with hardened refill"
```

---

### Task 5: `signal-handlers.ts` — graceful shutdown

**Files:**
- Create: `src/signal-handlers.ts`
- Test: `__tests__/src/signal-handlers.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, test, expect, mock } from "bun:test";
import { setupSignalHandlers } from "../../src/signal-handlers";

function makeProcessRef() {
  const handlers: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {};
  return {
    on(event: "SIGINT" | "SIGTERM", listener: () => void) {
      handlers[event] = listener;
    },
    fire(event: "SIGINT" | "SIGTERM") {
      handlers[event]?.();
    },
  };
}

describe("setupSignalHandlers", () => {
  test("SIGINT calls server.stop then exits 0", async () => {
    const server = { stop: mock(() => {}) };
    const exit = mock(() => {});
    const processRef = makeProcessRef();
    const fakeSetTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: fakeSetTimeout,
      exitRef: exit as unknown as (code?: number) => void,
    });
    processRef.fire("SIGINT");
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("double-signal is suppressed", () => {
    const server = { stop: mock(() => {}) };
    const exit = mock(() => {});
    const processRef = makeProcessRef();
    const fakeSetTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: fakeSetTimeout,
      exitRef: exit as unknown as (code?: number) => void,
    });
    processRef.fire("SIGTERM");
    processRef.fire("SIGTERM");
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  test("server.stop throwing causes exit 1", () => {
    const server = { stop: mock(() => { throw new Error("nope"); }) };
    const exit = mock(() => {});
    const processRef = makeProcessRef();
    const fakeSetTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: fakeSetTimeout,
      exitRef: exit as unknown as (code?: number) => void,
    });
    processRef.fire("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("shutdownDrainMs is honored", () => {
    const server = { stop: mock(() => {}) };
    const exit = mock(() => {});
    const processRef = makeProcessRef();
    let observedDelay = -1;
    const fakeSetTimeout = ((fn: () => void, delay?: number) => {
      observedDelay = delay ?? -1;
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    setupSignalHandlers(server, {
      processRef,
      setTimeoutRef: fakeSetTimeout,
      exitRef: exit as unknown as (code?: number) => void,
      shutdownDrainMs: 50,
    });
    processRef.fire("SIGINT");
    expect(observedDelay).toBe(50);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Create `src/signal-handlers.ts`**

```ts
import { logger } from "./logger";

interface StoppableServer {
  stop: () => void;
}

interface ProcessLike {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface SignalHandlerOptions {
  processRef?: ProcessLike;
  setTimeoutRef?: typeof setTimeout;
  exitRef?: (code?: number) => void;
  /**
   * Milliseconds to wait between `server.stop()` and `process.exit(0)`,
   * giving in-flight Bun.serve responses time to drain. Default 200.
   */
  shutdownDrainMs?: number;
}

export function setupSignalHandlers(
  server: StoppableServer,
  options: SignalHandlerOptions = {},
) {
  const processRef = options.processRef ?? process;
  const setTimeoutRef = options.setTimeoutRef ?? setTimeout;
  const exitRef = options.exitRef ?? process.exit;
  const drainMs = options.shutdownDrainMs ?? 200;

  let shuttingDown = false;

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ event: "server.shutdown_requested", meta: { signal } });
    try {
      server.stop();
    } catch (err) {
      logger.error({
        event: "server.shutdown_failed",
        meta: { signal, error: String(err) },
      });
      exitRef(1);
      return;
    }

    setTimeoutRef(() => {
      logger.info({ event: "server.stopped", meta: { signal } });
      exitRef(0);
    }, drainMs);
  };

  processRef.on("SIGINT", () => shutdown("SIGINT"));
  processRef.on("SIGTERM", () => shutdown("SIGTERM"));

  return { shutdown };
}
```

- [ ] **Step 4: Run — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src/signal-handlers.ts __tests__/src/signal-handlers.test.ts
git commit --no-gpg-sign -m "feat: add signal handlers with configurable drain"
```

---

### Task 6: `metrics.ts` — request counter + snapshot

**Files:**
- Create: `src/metrics.ts`
- Test: `__tests__/src/metrics.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import { recordHttpRequest, getMetricsSnapshot, __resetMetricsForTest } from "../../src/metrics";

beforeEach(() => __resetMetricsForTest());

describe("metrics", () => {
  test("counts requests and averages latency", () => {
    recordHttpRequest("/x", 200, 10);
    recordHttpRequest("/x", 200, 20);
    const snap = getMetricsSnapshot();
    expect(snap.routes["/x"]).toEqual({ requests: 2, errors: 0, avgLatencyMs: 15 });
  });

  test("counts errors when status >= 400", () => {
    recordHttpRequest("/y", 400, 5);
    recordHttpRequest("/y", 500, 5);
    recordHttpRequest("/y", 200, 5);
    const snap = getMetricsSnapshot();
    expect(snap.routes["/y"]?.errors).toBe(2);
  });

  test("empty snapshot has empty routes map", () => {
    expect(getMetricsSnapshot().routes).toEqual({});
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Create `src/metrics.ts`**

```ts
interface RouteMetric {
  requests: number;
  errors: number;
  totalLatencyMs: number;
}

let routeMetrics = new Map<string, RouteMetric>();

function getRouteMetric(route: string): RouteMetric {
  const existing = routeMetrics.get(route);
  if (existing) return existing;
  const fresh: RouteMetric = { requests: 0, errors: 0, totalLatencyMs: 0 };
  routeMetrics.set(route, fresh);
  return fresh;
}

export function recordHttpRequest(
  route: string,
  status: number,
  latencyMs: number,
): void {
  const m = getRouteMetric(route);
  m.requests += 1;
  m.totalLatencyMs += latencyMs;
  if (status >= 400) m.errors += 1;
}

export interface MetricsSnapshot {
  routes: Record<string, { requests: number; errors: number; avgLatencyMs: number }>;
}

export function getMetricsSnapshot(): MetricsSnapshot {
  const routes: MetricsSnapshot["routes"] = {};
  for (const [route, m] of routeMetrics.entries()) {
    routes[route] = {
      requests: m.requests,
      errors: m.errors,
      avgLatencyMs:
        m.requests === 0 ? 0 : Number((m.totalLatencyMs / m.requests).toFixed(2)),
    };
  }
  return { routes };
}

/** Test-only reset hook. Not exported from the package surface in any consumer. */
export function __resetMetricsForTest(): void {
  routeMetrics = new Map();
}
```

- [ ] **Step 4: Run — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src/metrics.ts __tests__/src/metrics.test.ts
git commit --no-gpg-sign -m "feat: add request metrics snapshot"
```

---

### Task 7: `routes.ts` — three handlers

**Files:**
- Create: `src/routes.ts`
- Test: `__tests__/src/routes.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, test, expect } from "bun:test";
import {
  handleSimpleWallet,
  handleMultisigWallet,
  handleLive,
} from "../../src/routes";

function get(url: string): Request {
  return new Request(url, { method: "GET" });
}

describe("handleLive", () => {
  test("returns {live: true}", async () => {
    const res = handleLive(get("http://x/live"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
  });
});

describe("handleSimpleWallet", () => {
  test("returns words + 22 addresses + numeric genTime", async () => {
    const res = handleSimpleWallet(get("http://x/simpleWallet"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      words: string;
      addresses: string[];
      genTime: number;
    };
    expect(body.words.split(" ")).toHaveLength(24);
    expect(body.addresses).toHaveLength(22);
    expect(typeof body.genTime).toBe("number");
  });
});

describe("handleMultisigWallet validation", () => {
  test("missing params -> 400 INVALID_REQUEST", async () => {
    const res = handleMultisigWallet(get("http://x/multisigWallet"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_REQUEST");
  });

  test("NaN -> 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=foo&numSignatures=2"),
    );
    expect(res.status).toBe(400);
  });

  test("participants < 1 -> 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=0&numSignatures=1"),
    );
    expect(res.status).toBe(400);
  });

  test("numSignatures > participants -> 400", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=2&numSignatures=3"),
    );
    expect(res.status).toBe(400);
  });

  test("happy path returns wallets array", async () => {
    const res = handleMultisigWallet(
      get("http://x/multisigWallet?participants=2&numSignatures=2"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wallets: { addresses: string[] }[];
      genTime: number;
    };
    expect(body.wallets).toHaveLength(2);
    expect(typeof body.genTime).toBe("number");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Create `src/routes.ts`**

```ts
import { getSimpleWalletFromCache } from "./wallet.cache";
import { generateMultisigWallet } from "./wallet.service";
import { jsonErrorFromService } from "./http";
import { InvalidRequestError } from "./errors";

/** GET /simpleWallet — return a pre-cached BIP39 wallet with 22 derived addresses. */
export function handleSimpleWallet(_req: Request): Response {
  const start = performance.now();
  const wallet = getSimpleWalletFromCache();
  const genTime = Number((performance.now() - start).toFixed(2));
  return Response.json({ ...wallet, genTime });
}

/** GET /multisigWallet — generate N-of-M multisig wallets from query params. */
export function handleMultisigWallet(req: Request): Response {
  const start = performance.now();
  const url = new URL(req.url);
  const participantsParam = url.searchParams.get("participants");
  const numSignaturesParam = url.searchParams.get("numSignatures");

  if (!participantsParam || !numSignaturesParam) {
    return jsonErrorFromService(
      new InvalidRequestError(
        "Missing required query parameters: participants and numSignatures",
      ),
    );
  }

  const participants = Number.parseInt(participantsParam, 10);
  const numSignatures = Number.parseInt(numSignaturesParam, 10);

  if (Number.isNaN(participants) || Number.isNaN(numSignatures)) {
    return jsonErrorFromService(
      new InvalidRequestError(
        "participants and numSignatures must be valid integers",
      ),
    );
  }

  if (participants < 1) {
    return jsonErrorFromService(
      new InvalidRequestError("participants must be >= 1"),
    );
  }

  if (numSignatures < 1) {
    return jsonErrorFromService(
      new InvalidRequestError("numSignatures must be >= 1"),
    );
  }

  if (numSignatures > participants) {
    return jsonErrorFromService(
      new InvalidRequestError("numSignatures must be <= participants"),
    );
  }

  const wallets = generateMultisigWallet(participants, numSignatures);
  const genTime = Number((performance.now() - start).toFixed(2));
  return Response.json({ wallets, genTime });
}

/** GET /live — liveness probe (always 200). */
export function handleLive(_req: Request): Response {
  return Response.json({ live: true });
}
```

- [ ] **Step 4: Run — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts __tests__/src/routes.test.ts
git commit --no-gpg-sign -m "feat: add wallet and live route handlers"
```

---

### Task 8: `app.ts` — observability pipeline

**Files:**
- Create: `src/app.ts`
- Test: `__tests__/src/app-test-name.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

type ConsoleMethod = "log" | "warn" | "error";
let captured: { method: ConsoleMethod; payload: Record<string, unknown> }[] = [];
let originals: Record<ConsoleMethod, (...args: unknown[]) => void>;

function captureConsole(method: ConsoleMethod) {
  return mock((line: unknown) => {
    captured.push({
      method,
      payload: JSON.parse(String(line)) as Record<string, unknown>,
    });
  });
}

beforeEach(() => {
  captured = [];
  originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = captureConsole("log");
  console.warn = captureConsole("warn");
  console.error = captureConsole("error");
});

afterEach(() => {
  console.log = originals.log;
  console.warn = originals.warn;
  console.error = originals.error;
});

describe("withObservability via createRoutes", () => {
  test("propagates X-Test-Name to http.request log", async () => {
    const { createRoutes } = await import("../../src/app");
    const handler = createRoutes()["/live"].GET;
    const res = await handler(
      new Request("http://x/live", {
        method: "GET",
        headers: { "x-test-name": "alpha" },
      }),
    );
    expect(res.status).toBe(200);
    const log = captured.find(
      (c) => c.payload.event === "http.request" && c.payload.route === "/live",
    );
    expect(log?.payload.testName).toBe("alpha");
    expect(log?.payload.requestId).toBeTypeOf("string");
    expect(log?.payload.status).toBe(200);
    expect(log?.payload.latencyMs).toBeTypeOf("number");
  });

  test("defaults to testName=unknown when header missing", async () => {
    const { createRoutes } = await import("../../src/app");
    const handler = createRoutes()["/live"].GET;
    await handler(new Request("http://x/live", { method: "GET" }));
    const log = captured.find(
      (c) => c.payload.event === "http.request" && c.payload.route === "/live",
    );
    expect(log?.payload.testName).toBe("unknown");
  });

  test("echoes x-request-id when provided", async () => {
    const { createRoutes } = await import("../../src/app");
    const handler = createRoutes()["/live"].GET;
    const res = await handler(
      new Request("http://x/live", {
        method: "GET",
        headers: { "x-request-id": "abc-123" },
      }),
    );
    expect(res.headers.get("x-request-id")).toBe("abc-123");
  });

  test("uncaught throw → 500 INTERNAL_ERROR and http.unhandled_error log", async () => {
    mock.module("../../src/routes", () => ({
      handleSimpleWallet: () => { throw new Error("boom"); },
      handleMultisigWallet: () => new Response(""),
      handleLive: () => new Response(""),
    }));
    const { createRoutes } = await import("../../src/app");
    const handler = createRoutes()["/simpleWallet"].GET;
    const res = await handler(new Request("http://x/simpleWallet", { method: "GET" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("INTERNAL_ERROR");
    expect(body.retryable).toBe(false);
    const errorLog = captured.find(
      (c) => c.payload.event === "http.unhandled_error",
    );
    expect(errorLog).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Create `src/app.ts`**

```ts
import {
  handleSimpleWallet,
  handleMultisigWallet,
  handleLive,
} from "./routes";
import { ensureRequestId, jsonError, withRequestIdHeader } from "./http";
import { logger } from "./logger";
import { recordHttpRequest } from "./metrics";
import { runWithTestName } from "./log-context";

type Handler = (req: Request) => Response | Promise<Response>;

function withObservability(route: string, handler: Handler): Handler {
  return (req: Request) => {
    const rawTestName = req.headers.get("x-test-name") ?? "";
    return runWithTestName(rawTestName, () => runHandler(route, req, handler));
  };
}

async function runHandler(
  route: string,
  req: Request,
  handler: Handler,
): Promise<Response> {
  const requestId = ensureRequestId(req);
  const startedAt = performance.now();
  let status = 500;
  let res: Response;

  try {
    res = await handler(req);
    status = res.status;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({
      event: "http.unhandled_error",
      requestId,
      meta: { route, error: message },
    });
    res = jsonError(500, "INTERNAL_ERROR", "Internal Server Error", false);
    status = 500;
  } finally {
    const latencyMs = Number((performance.now() - startedAt).toFixed(2));
    recordHttpRequest(route, status, latencyMs);
    logger.info({
      event: "http.request",
      requestId,
      meta: { route, method: req.method, status, latencyMs },
    });
  }
  return withRequestIdHeader(res, requestId);
}

export function createRoutes() {
  return {
    "/simpleWallet":  { GET: withObservability("/simpleWallet",  handleSimpleWallet) },
    "/multisigWallet":{ GET: withObservability("/multisigWallet",handleMultisigWallet) },
    "/live":          { GET: withObservability("/live",          handleLive) },
  };
}
```

- [ ] **Step 4: Run — expect PASS**.

Note: `logger.info`'s `requestId` lives at top level (matching PR1's `LogPayload`), so the test assertions check `payload.requestId`, not `payload.meta.requestId`. `route`, `method`, `status`, `latencyMs` go in `meta` per the same PR1 contract — adjust test assertions if needed.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts __tests__/src/app-test-name.test.ts
git commit --no-gpg-sign -m "feat: add observability pipeline and route map"
```

---

### Task 9: Rewrite `index.ts` and add end-to-end smoke test

**Files:**
- Modify: `index.ts`
- Test: `__tests__/index.test.ts` (new)

- [ ] **Step 1: Write failing E2E test**

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer } from "../src/test-server";
import { createRoutes } from "../src/app";
import { initializeCache } from "../src/wallet.cache";

let server: ReturnType<typeof startTestServer>;
let baseUrl: string;

beforeAll(() => {
  initializeCache();
  server = startTestServer({ port: 0, routes: createRoutes() });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("end-to-end", () => {
  test("GET /live → {live: true} with x-request-id echo", async () => {
    const res = await fetch(`${baseUrl}/live`, { headers: { "x-request-id": "e2e-1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("e2e-1");
    expect(await res.json()).toEqual({ live: true });
  });

  test("GET /simpleWallet → 24 words + 22 addresses", async () => {
    const res = await fetch(`${baseUrl}/simpleWallet`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.words.split(" ")).toHaveLength(24);
    expect(body.addresses).toHaveLength(22);
  });

  test("GET /multisigWallet?participants=2&numSignatures=2 → ok", async () => {
    const res = await fetch(`${baseUrl}/multisigWallet?participants=2&numSignatures=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wallets).toHaveLength(2);
  });

  test("GET /multisigWallet?participants=1&numSignatures=2 → 400", async () => {
    const res = await fetch(`${baseUrl}/multisigWallet?participants=1&numSignatures=2`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_REQUEST");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (test file references modules that exist, but route map keys must align with new server wiring).

- [ ] **Step 3: Rewrite `index.ts`**

```ts
import { config } from "./src/config";
import { logger } from "./src/logger";
import { initializeCache } from "./src/wallet.cache";
import { createRoutes } from "./src/app";
import { setupSignalHandlers } from "./src/signal-handlers";

initializeCache();

const server = Bun.serve({
  port: config.PORT,
  routes: createRoutes(),
});

setupSignalHandlers(server);

logger.info({
  event: "server.started",
  meta: { port: server.port },
});
```

- [ ] **Step 4: Run E2E test — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add index.ts __tests__/index.test.ts
git commit --no-gpg-sign -m "feat: wire wallet routes into Bun.serve bootstrap"
```

Note: `__tests__/index.test.ts` is outside `__tests__/src/`, so `bun run test:unit` (which globs `__tests__/src`) won't pick it up. Run it explicitly with `bun test __tests__/index.test.ts` — or update the `test:unit` script to include both directories. Decide based on whether E2E tests should be part of the unit gate. **Recommendation:** keep E2E out of `test:unit` for speed; add a separate `test:e2e` script that runs `bun test __tests__/index.test.ts`, and call both from `bun run check`.

If updating package.json scripts:

```json
"test:unit": "bun test __tests__/src",
"test:e2e": "bun test __tests__/index.test.ts",
"check": "bun run typecheck && bun run test:unit && bun run test:e2e"
```

---

### Task 10: Final quality gate

- [ ] **Step 1: Full check**

Run: `bun run check`
Expected: All typecheck + unit + e2e tests pass.

- [ ] **Step 2: If package.json was updated for `test:e2e`, commit**

```bash
git add package.json
git commit --no-gpg-sign -m "chore: split test:unit and test:e2e scripts"
```

- [ ] **Step 3: Sanity-check the chain**

```bash
git log --oneline main..pr-2-wallet-endpoints
```

Expected: ~9 commits — spec + each task's feat commit. Each commit
self-contained.

- [ ] **Step 4: Manual curl smoke (optional, requires Hathor wallet-lib install)**

```bash
bun run start &
sleep 1
curl -H 'X-Test-Name: manual' localhost:3020/live
curl localhost:3020/simpleWallet
curl 'localhost:3020/multisigWallet?participants=2&numSignatures=2'
kill %1
```

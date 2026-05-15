import {
  generateSimpleWallet as defaultGenerator,
  type SimpleWallet,
} from "./wallet.service";
import { config } from "./config";
import { logger } from "./logger";

/**
 * FIFO cache of pre-generated simple wallets.
 *
 * `getSimpleWalletFromCache` is synchronous — it returns the head of
 * the cache (or generates on the spot if empty) and schedules an
 * asynchronous refill so the cost of seed generation is amortised
 * across requests rather than paid on the hot path.
 *
 * The refill chain is hardened against generator failures: if
 * `generateSimpleWallet` throws, we log a structured error, clear
 * `isRefilling`, and schedule one more iteration so the cache can
 * self-heal once the underlying cause clears. Without that try/catch,
 * a single throw would leave `isRefilling = true` forever and silently
 * freeze the cache.
 */
const simpleWalletCache: SimpleWallet[] = [];
let isRefilling = false;
let generator: () => SimpleWallet = defaultGenerator;

function fillCacheSync(): void {
  while (simpleWalletCache.length < config.SIMPLE_WALLET_CACHE_SIZE) {
    simpleWalletCache.push(generator());
  }
}

function refillCacheAsync(): void {
  if (isRefilling) return;
  if (simpleWalletCache.length >= config.SIMPLE_WALLET_CACHE_SIZE) return;
  isRefilling = true;
  // One retry per refill cycle. After the retry fails (or succeeds),
  // the cycle ends — a subsequent getSimpleWalletFromCache() call
  // can start a fresh cycle. Without this flag, a persistently
  // failing generator would spin-loop via setImmediate.
  let retryUsed = false;

  const refillOne = () => {
    if (simpleWalletCache.length >= config.SIMPLE_WALLET_CACHE_SIZE) {
      isRefilling = false;
      return;
    }
    try {
      simpleWalletCache.push(generator());
      setImmediate(refillOne);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({
        event: "wallet_cache.refill_failed",
        meta: { error: message },
      });
      if (retryUsed) {
        isRefilling = false;
        return;
      }
      retryUsed = true;
      // Keep isRefilling true so a concurrent consumer call doesn't
      // launch a second chain on top of this one. The retry runs
      // inside this cycle.
      setImmediate(refillOne);
    }
  };

  setImmediate(refillOne);
}

/**
 * Pop the oldest cached wallet, kicking off a background refill. Falls
 * back to synchronous generation when the cache is empty so callers
 * never block on the refill cycle.
 */
export function getSimpleWalletFromCache(): SimpleWallet {
  const w = simpleWalletCache.shift();
  refillCacheAsync();
  return w ?? generator();
}

/** Current cache occupancy. Exposed for observability and tests. */
export function getCacheSize(): number {
  return simpleWalletCache.length;
}

/**
 * Fill the cache synchronously up to `SIMPLE_WALLET_CACHE_SIZE`. Called
 * once at startup before `Bun.serve` begins accepting connections so
 * the first request gets a cached wallet instead of paying the
 * generation cost on its hot path.
 */
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

/**
 * Test-only hook for injecting a wallet generator. Pass `null` to
 * restore the default (`generateSimpleWallet` from `./wallet.service`).
 *
 * Exists because `bun:test`'s `mock.module` doesn't reliably rebind
 * import specifiers that the consumer captured at module-load time —
 * the cache binds `generateSimpleWallet` once, so subsequent
 * `mock.module` calls leave that binding intact. Direct injection
 * sidesteps the issue cleanly.
 */
export function __setGeneratorForTest(
  fn: (() => SimpleWallet) | null,
): void {
  generator = fn ?? defaultGenerator;
}

/** Test-only: drop all cached wallets and clear the refill flag. */
export function __resetCacheForTest(): void {
  simpleWalletCache.length = 0;
  isRefilling = false;
}

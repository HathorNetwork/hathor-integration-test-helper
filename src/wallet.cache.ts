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

/**
 * Invalidation token for in-flight refill chains.
 *
 * A refill is a self-rescheduling `setImmediate` chain, so clearing `isRefilling`
 * does not stop one that is already queued — the pending closure still runs and
 * still calls `generator()`. Swapping the generator or emptying the cache out
 * from under a live chain therefore lets it keep filling, with whichever
 * generator is installed by the time it wakes. Each chain captures the epoch it
 * started in and stops as soon as that no longer matches.
 */
let cacheEpoch = 0;

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
  const epoch = cacheEpoch;

  const refillOne = () => {
    // A reset or generator swap happened after this chain was queued; abandon
    // it rather than generate into a cache that is no longer this chain's.
    if (epoch !== cacheEpoch) return;
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
  // Invalidate live refill chains: a chain queued under the previous generator
  // would otherwise wake up and generate with this one. Restoring the real
  // generator is the costly direction — an orphaned chain then refills the whole
  // cache with real BIP39 seeds, blocking the loop for hundreds of ms inside
  // whatever test happens to run next.
  cacheEpoch += 1;
  isRefilling = false;
  generator = fn ?? defaultGenerator;
}

/**
 * Test-only: drop all cached wallets and stop any in-flight refill, so a
 * background chain from a previous test cannot repopulate the cache afterwards.
 */
export function __resetCacheForTest(): void {
  cacheEpoch += 1;
  simpleWalletCache.length = 0;
  isRefilling = false;
}

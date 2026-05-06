import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";

/**
 * Replace wallet-lib's BigInt reviver for Bun/JSC compatibility.
 *
 * wallet-lib's reviver swallows two specific V8 SyntaxError messages
 * when JSC throws with different wording. We swallow `SyntaxError` from
 * `BigInt(source)` regardless of message text, but only when `source`
 * looks like a legitimate JSON number (integer, decimal, or scientific
 * notation). Genuinely malformed input (e.g. `"42n"`, `"0x"`, `"1_000"`)
 * still re-throws so corruption from a buggy or compromised upstream
 * isn't silently downgraded to the JS-parsed `value`.
 */
const NUMERIC_SOURCE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

export function applyWalletLibBigIntPatch(): void {
  JSONBigInt.bigIntReviver = function bunCompatibleBigIntReviver(
    _key: string,
    value: unknown,
    context: { source: string },
  ) {
    if (typeof value !== "number") return value;

    try {
      const bigIntValue = BigInt(context.source);
      if (bigIntValue < Number.MIN_SAFE_INTEGER || bigIntValue > Number.MAX_SAFE_INTEGER) {
        return bigIntValue;
      }
      return value;
    } catch (e) {
      if (e instanceof SyntaxError && NUMERIC_SOURCE.test(context.source)) {
        return value;
      }
      throw e;
    }
  };
}

import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";

/**
 * Replace wallet-lib's BigInt reviver for Bun/JSC compatibility.
 *
 * wallet-lib handles V8-specific BigInt parsing errors when numbers such as
 * `1.7e10` are parsed. Bun's JavaScriptCore throws a different SyntaxError
 * message; this patch keeps the same behavior while preventing spurious errors.
 */
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
      if (e instanceof SyntaxError) {
        return value;
      }
      throw e;
    }
  };
}


import { test, expect } from "bun:test";
import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";

/**
 * Tests for the wallet-lib BigInt-reviver compatibility patch.
 *
 * The patch itself lives at `patches/@hathor%2Fwallet-lib@3.0.1.patch`
 * and is applied at install time by `bun install` (registered via
 * `patchedDependencies` in package.json). It extends the upstream
 * SyntaxError-message allowlist with Bun's specific wording so that
 * `JSONBigInt.parse` does not re-throw on floats or scientific notation.
 *
 * Two kinds of tests live here:
 *
 *   1. A sentinel test that verifies Bun is still throwing the exact
 *      SyntaxError wording our patch expects. If a future Bun release
 *      changes that wording, this test fails first — with explicit
 *      instructions on how to update the patch — instead of every
 *      JSONBigInt.parse call surfacing as an opaque crash at runtime.
 *
 *   2. Scenario tests covering the parse behaviors the rest of the
 *      service depends on (integers preserved as numbers, floats and
 *      scientific notation handled gracefully, unsafe-range integers
 *      promoted to bigint).
 */

test("[sentinel] Bun's BigInt SyntaxError wording matches the patch's allowlist", () => {
  // Trigger BigInt() directly — not via JSONBigInt.parse — so the
  // diagnostic this test prints stays focused on the engine behavior
  // rather than the wallet-lib call stack.
  let actualMessage: string | undefined;
  try {
    BigInt("1.5");
  } catch (e) {
    if (!(e instanceof SyntaxError)) {
      throw new Error(
        `BigInt("1.5") threw a non-SyntaxError on Bun ${Bun.version}: ` +
          `${(e as Error).constructor.name}: ${(e as Error).message}`,
      );
    }
    actualMessage = e.message;
  }
  if (actualMessage === undefined) {
    throw new Error(
      `BigInt("1.5") did not throw on Bun ${Bun.version}; the patch ` +
        `assumes a SyntaxError. Re-evaluate whether the patch is still needed.`,
    );
  }

  const expectedMessage = "Failed to parse String to BigInt";
  if (actualMessage !== expectedMessage) {
    throw new Error(
      [
        "",
        "Bun's BigInt SyntaxError wording has changed.",
        `  Expected: "${expectedMessage}"`,
        `  Got:      "${actualMessage}"`,
        "",
        "Our wallet-lib patch matches the SyntaxError message string",
        "exactly. With the wording changed, every JSONBigInt.parse call",
        "on a float or scientific-notation number will re-throw instead",
        "of falling back to the JS-parsed number.",
        "",
        "To fix:",
        "  1. Edit patches/@hathor%2Fwallet-lib@3.0.1.patch",
        `  2. Add "${actualMessage}" to the SyntaxError message allowlist`,
        "     in lib/utils/bigint.js",
        "  3. Run `bun install` to reapply the patch",
        "  4. Update the expectedMessage in this test to match",
        "",
        `Bun version: ${Bun.version}`,
        "",
      ].join("\n"),
    );
  }
});

test("parses float numbers without crashing", () => {
  const result = JSONBigInt.parse('{"v":1.5}');
  expect(result.v).toBe(1.5);
});

test("parses scientific notation without crashing", () => {
  const result = JSONBigInt.parse('{"v":1e2}');
  expect(result.v).toBe(100);
});

test("parses float with scientific notation without crashing", () => {
  const result = JSONBigInt.parse('{"v":1.7e10}');
  expect(result.v).toBe(17000000000);
});

test("preserves normal integers as numbers", () => {
  const result = JSONBigInt.parse('{"v":42}');
  expect(result.v).toBe(42);
  expect(typeof result.v).toBe("number");
});

test("converts unsafe large integers to BigInt", () => {
  const result = JSONBigInt.parse('{"v":9999999999999999999}');
  expect(typeof result.v).toBe("bigint");
  expect(result.v).toBe(9999999999999999999n);
});

test("handles string values unchanged", () => {
  const result = JSONBigInt.parse('{"type":"pong","msg":"hello"}');
  expect(result.type).toBe("pong");
  expect(result.msg).toBe("hello");
});

test("handles mixed types in a realistic websocket message", () => {
  const msg = '{"type":"dashboard:metrics","timestamp":1.708e12,"height":42,"weight":1e2}';
  const result = JSONBigInt.parse(msg);
  expect(result.type).toBe("dashboard:metrics");
  expect(result.timestamp).toBe(1.708e12);
  expect(result.height).toBe(42);
  expect(result.weight).toBe(100);
});

test("preserves MAX_SAFE_INTEGER as a number (boundary check)", () => {
  // The reviver only promotes to BigInt when the value escapes the safe
  // integer range. A regression that flips < to <= would convert
  // MAX_SAFE_INTEGER itself to bigint and break wallet-lib callers
  // expecting a `number`.
  const result = JSONBigInt.parse(`{"v":${Number.MAX_SAFE_INTEGER}}`);
  expect(typeof result.v).toBe("number");
  expect(result.v).toBe(Number.MAX_SAFE_INTEGER);
});

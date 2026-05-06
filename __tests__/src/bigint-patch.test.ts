import { test, expect, beforeAll } from "bun:test";
import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";
import { applyWalletLibBigIntPatch } from "../../src/bigint-patch";

/**
 * Tests for the Bun/JSC BigInt reviver replacement.
 *
 * wallet-lib's JSONBigInt.parse runs every JSON number through BigInt().
 * Floats and scientific notation (e.g. "1.5", "1e2") cause BigInt() to throw
 * a SyntaxError. The library only matches V8 error messages, so on Bun/JSC
 * it logs an error and re-throws. We replace the reviver entirely so the
 * JSC case is handled silently — matching V8 behavior.
 *
 * The real patch is applied once in beforeAll before running assertions.
 */
beforeAll(() => {
  applyWalletLibBigIntPatch();
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
  // The reviver swallows BigInt() SyntaxErrors only for legitimate JSON
  // numbers and only converts to BigInt when the value escapes the safe
  // integer range. A regression that flips < to <= would convert
  // MAX_SAFE_INTEGER itself to bigint and break wallet-lib callers
  // expecting a `number`.
  const result = JSONBigInt.parse(`{"v":${Number.MAX_SAFE_INTEGER}}`);
  expect(typeof result.v).toBe("number");
  expect(result.v).toBe(Number.MAX_SAFE_INTEGER);
});

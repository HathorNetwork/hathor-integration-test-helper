import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { JSONBigInt } from "@hathor/wallet-lib/lib/utils/bigint";

const PATCHED_BIGINT_PATH = resolve(
  import.meta.dir,
  "../../node_modules/@hathor/wallet-lib/lib/utils/bigint.js",
);
const PATCHED_FRAGMENT = "Failed to parse String to BigInt";

/**
 * Tests for the wallet-lib BigInt-reviver compatibility patch.
 *
 * The patch itself lives at `patches/@hathor%2Fwallet-lib@3.0.1.patch`
 * and is applied at install time by `bun install` (registered via
 * `patchedDependencies` in package.json). It extends the upstream
 * SyntaxError-message allowlist with Bun's specific wording so that
 * `JSONBigInt.parse` does not re-throw on floats or scientific notation.
 *
 * Three kinds of tests live here:
 *
 *   1. A sentinel test that verifies Bun is still throwing the exact
 *      SyntaxError wording our patch expects. If a future Bun release
 *      changes that wording, this test fails first — with explicit
 *      instructions on how to update the patch — instead of every
 *      JSONBigInt.parse call surfacing as an opaque crash at runtime.
 *
 *   2. A sentinel test that verifies the patch is actually present in
 *      node_modules. If wallet-lib is upgraded and the patch in
 *      patches/ no longer applies (mismatched version key, or upstream
 *      moved/renamed the catch block), `bun install` would print a
 *      patch-apply warning that is easy to scroll past — this test
 *      surfaces the same failure with explicit fix steps.
 *
 *   3. Scenario tests covering the parse behaviors the rest of the
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

test("[sentinel] wallet-lib BigInt patch is applied in node_modules", async () => {
  // Read the upstream file directly. If the patch in patches/ failed to
  // apply — usually because wallet-lib was upgraded and the patch key
  // `@hathor/wallet-lib@<version>` no longer matches the installed
  // version — `bun install` will have left the upstream file untouched
  // and emitted a warning that's easy to miss. This test surfaces that
  // state as a hard failure in CI.
  const file = Bun.file(PATCHED_BIGINT_PATH);

  if (!(await file.exists())) {
    throw new Error(
      [
        "",
        "wallet-lib's bigint.js is missing from node_modules:",
        `  ${PATCHED_BIGINT_PATH}`,
        "",
        "Either node_modules is in a bad state or wallet-lib reorganized",
        "its file layout. Run `bun install` to restore; if the file path",
        "actually changed in a new wallet-lib version, regenerate the patch",
        "and update PATCHED_BIGINT_PATH in this test.",
        "",
      ].join("\n"),
    );
  }

  const contents = await file.text();
  if (contents.includes(PATCHED_FRAGMENT)) {
    return;
  }

  throw new Error(
    [
      "",
      "The wallet-lib BigInt patch is NOT applied to node_modules.",
      `  Looking for: "${PATCHED_FRAGMENT}"`,
      `  In:          ${PATCHED_BIGINT_PATH}`,
      "",
      "Without this patch, every JSONBigInt.parse() call on a float or",
      "scientific-notation number on Bun re-throws as a cryptic",
      "'unexpected error in bigIntReviver' deep inside wallet-lib.",
      "",
      "Most likely cause: wallet-lib was upgraded (e.g. 3.0.1 → 3.0.2)",
      "and the patch key in package.json's `patchedDependencies` no",
      "longer matches the installed version, so `bun install` skipped",
      "the patch. Check the install output for a patch-apply warning.",
      "",
      "To fix:",
      "  1. Note the wallet-lib version in package.json's `dependencies`",
      "  2. Regenerate the patch against that version:",
      "       bun patch @hathor/wallet-lib@<version>",
      "       # edit node_modules/@hathor/wallet-lib/lib/utils/bigint.js",
      "       # add Bun's SyntaxError wording to the catch allowlist",
      "       bun patch --commit node_modules/@hathor/wallet-lib",
      "  3. Delete the obsolete patches/@hathor%2Fwallet-lib@*.patch file",
      "  4. Re-run this test to confirm",
      "",
    ].join("\n"),
  );
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

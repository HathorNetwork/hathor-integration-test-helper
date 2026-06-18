import { describe, test, expect } from "bun:test";
import {
  generateSimpleWallet,
  generateMultisigWallet,
} from "../../src/wallet.service";
import { isValidHathorAddress } from "../../src/address";

describe("generateSimpleWallet", () => {
  test("returns a 24-word BIP39 seed and ADDRESS_COUNT addresses", () => {
    const w = generateSimpleWallet();
    expect(w.words.split(" ")).toHaveLength(24);
    expect(w.addresses).toHaveLength(22);
  });

  test("all addresses validate against the configured network", () => {
    const w = generateSimpleWallet();
    for (const addr of w.addresses) {
      expect(isValidHathorAddress(addr)).toBe(true);
    }
  });

  test("two calls produce different seeds (no caching at this layer)", () => {
    const a = generateSimpleWallet();
    const b = generateSimpleWallet();
    expect(a.words).not.toBe(b.words);
  });
});

describe("generateMultisigWallet", () => {
  test("returns one wallet per participant", () => {
    const w = generateMultisigWallet(3, 2);
    expect(w).toHaveLength(3);
  });

  test("all participants share the same derived addresses", () => {
    const w = generateMultisigWallet(3, 2);
    expect(w[0]!.addresses).toEqual(w[1]!.addresses);
    expect(w[1]!.addresses).toEqual(w[2]!.addresses);
    expect(w[0]!.addresses).toHaveLength(22);
  });

  test("pubkeys in multisigDebugData are sorted lexicographically", () => {
    const w = generateMultisigWallet(3, 2);
    const sorted = [...w[0]!.multisigDebugData.pubkeys].sort();
    expect(w[0]!.multisigDebugData.pubkeys).toEqual(sorted);
  });

  // Contract lock: this exact shape mirrors the `multisigDebugData` of
  // wallet-lib's PrecalculatedWalletData
  // (__tests__/integration/helpers/wallet-precalculation.helper.ts). If it
  // drifts, the helper stops being a drop-in for the Lib — update the helper,
  // not this test, unless the Lib's contract itself changed.
  test("multisigDebugData is exactly { total, minSignatures, pubkeys }", () => {
    const w = generateMultisigWallet(3, 2);
    const debug = w[0]!.multisigDebugData;
    expect(debug.total).toBe(3);
    expect(debug.minSignatures).toBe(2);
    expect(debug.pubkeys).toHaveLength(3);
    // words[] dropped: it duplicated the whole seed set into every
    // participant and is reconstructable from each wallet's own `words`.
    expect(Object.keys(debug).sort()).toEqual([
      "minSignatures",
      "pubkeys",
      "total",
    ]);
  });

  test("the full seed set is still recoverable from per-wallet words", () => {
    const w = generateMultisigWallet(3, 2);
    const allSeeds = w.map((p) => p.words);
    expect(allSeeds).toHaveLength(3);
    for (const seed of allSeeds) {
      expect(seed.split(" ")).toHaveLength(24);
    }
  });

  test("all multisig addresses validate against the configured network", () => {
    const w = generateMultisigWallet(2, 2);
    for (const addr of w[0]!.addresses) {
      expect(isValidHathorAddress(addr)).toBe(true);
    }
  });

  test("each wallet's shared arrays are independent copies (no aliasing)", () => {
    const w = generateMultisigWallet(3, 2);
    expect(w[0]!.addresses).not.toBe(w[1]!.addresses);
    expect(w[0]!.multisigDebugData.pubkeys).not.toBe(
      w[1]!.multisigDebugData.pubkeys,
    );
    // Mutating one wallet's arrays must not affect the others.
    w[0]!.addresses[0] = "MUTATED";
    expect(w[1]!.addresses[0]).not.toBe("MUTATED");
  });
});

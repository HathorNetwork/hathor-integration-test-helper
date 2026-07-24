import { describe, test, expect } from "bun:test";
import {
  generateSimpleWallet,
  generateMultisigWallet,
  generateShieldedAddresses,
} from "../../src/wallet.service";
import { isValidHathorAddress } from "../../src/address";
import { config } from "../../src/config";

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

describe("generateShieldedAddresses", () => {
  // A fixed integration-test seed — wallet-lib's genesis wallet — whose shielded
  // pairs are committed in the Lib as the source of truth:
  //   hathor-wallet-lib
  //   __tests__/integration/configuration/precalculated-shielded-addresses.ts
  //   → PRECALCULATED_SHIELDED_ADDRESSES[GENESIS_SEED]
  // Deriving from the same seed here and pinning index 0 to those exact values
  // proves this helper stays a byte-for-byte drop-in for the Lib's precalculated
  // shielded addresses. If it drifts, one side changed derivation — reconcile,
  // don't just relax the assertion.
  const GENESIS_SEED =
    "avocado spot town typical traffic vault danger century property shallow divorce festival spend attack anchor afford rotate green audit adjust fade wagon depart level";

  // PRECALCULATED_SHIELDED_ADDRESSES[GENESIS_SEED][0] in the Lib fixture above.
  const EXPECTED_INDEX_0 = {
    bip32AddressIndex: 0,
    shieldedBase58:
      "K3LV1px1o7fQ2aHcowfiXc1EcJ2f2QPwYjLeU8VDZbXi17eesUj14FVJXzpziWwTUW3Sz5KkhvqHGAYocchWixTGr2mGf643i",
    spendBase58: "WSFK832SPd6WKzpKkymj5Ya4JLnkvW2Y5A",
    scanPubkey:
      "02bdbcea0a38af8baac9831c7ce68a35cb165d513c7536a964691b3dff37f72392",
    spendPubkey:
      "02c6872a06b28b32fe31f79fe4c5dfc409b9f97d7b5f3c88a612ee937e46bda909",
  };

  // The exact key set of a PrecalculatedShieldedAddress entry, sorted. A field
  // transposition (e.g. scanPubkey<->spendPubkey) or a rename would still pass a
  // length/validity check, so lock the shape explicitly.
  const EXPECTED_KEYS = [
    "bip32AddressIndex",
    "scanPubkey",
    "shieldedBase58",
    "spendBase58",
    "spendPubkey",
  ];

  test("returns ADDRESS_COUNT pairs indexed 0..ADDRESS_COUNT-1", () => {
    const pairs = generateShieldedAddresses(GENESIS_SEED);
    expect(pairs).toHaveLength(config.ADDRESS_COUNT);
    pairs.forEach((p, i) => expect(p.bip32AddressIndex).toBe(i));
  });

  test("every entry has exactly the drop-in field set", () => {
    for (const p of generateShieldedAddresses(GENESIS_SEED)) {
      expect(Object.keys(p).sort()).toEqual(EXPECTED_KEYS);
    }
  });

  test("index 0 matches the wallet-lib committed shielded fixture (source of truth)", () => {
    const pairs = generateShieldedAddresses(GENESIS_SEED);
    expect(pairs[0]).toEqual(EXPECTED_INDEX_0);
  });

  test("is deterministic: same seed derives byte-identical pairs", () => {
    expect(generateShieldedAddresses(GENESIS_SEED)).toEqual(
      generateShieldedAddresses(GENESIS_SEED),
    );
  });

  test("generateSimpleWallet populates shieldedAddresses with the same contract", () => {
    const w = generateSimpleWallet();
    expect(w.shieldedAddresses).toHaveLength(config.ADDRESS_COUNT);
    for (const p of w.shieldedAddresses!) {
      expect(Object.keys(p).sort()).toEqual(EXPECTED_KEYS);
    }
  });
});

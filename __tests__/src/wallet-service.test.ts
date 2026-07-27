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
  // Fixture:
  //   hathor-wallet-lib
  //   __tests__/integration/configuration/precalculated-shielded-addresses.ts
  //   → PRECALCULATED_SHIELDED_ADDRESSES[GENESIS_SEED]
  // If it drifts, one side changed derivation — reconcile, don't just relax
  // the assertion.
  const GENESIS_SEED =
    "avocado spot town typical traffic vault danger century property shallow divorce festival spend attack anchor afford rotate green audit adjust fade wagon depart level";

  // First, second and last index of the window. Index 0 alone would not catch a
  // helper that derived every index from the same child key.
  const EXPECTED_ENTRIES = [
    {
      bip32AddressIndex: 0,
      shieldedBase58:
        "K3LV1px1o7fQ2aHcowfiXc1EcJ2f2QPwYjLeU8VDZbXi17eesUj14FVJXzpziWwTUW3Sz5KkhvqHGAYocchWixTGr2mGf643i",
      spendBase58: "WSFK832SPd6WKzpKkymj5Ya4JLnkvW2Y5A",
      scanPubkey:
        "02bdbcea0a38af8baac9831c7ce68a35cb165d513c7536a964691b3dff37f72392",
      spendPubkey:
        "02c6872a06b28b32fe31f79fe4c5dfc409b9f97d7b5f3c88a612ee937e46bda909",
    },
    {
      bip32AddressIndex: 1,
      shieldedBase58:
        "K3P4LYwvC8EYFfZuBAjU4hhyqPvzPQX9w14HkZyAa8wKdw4oXDwzQ58c2hjh9MGhwb6dYEBJNiTRPQRKbHTiStac4PYpvr7Pq",
      spendBase58: "WU2hD9d38tK9Gw1QuvT7Qc9Pe9ZvhuuCvY",
      scanPubkey:
        "03c053fdd3619ccf0b2abce410ff5719407235ee455d70ac4bd93f1f9a71f6dbd1",
      spendPubkey:
        "02a92a0f7422a1ccaf7fe061232e60194cee699984c778a60d2b8d9e6dae3b9825",
    },
    {
      bip32AddressIndex: 21,
      shieldedBase58:
        "K3MyYHda8yMGRKwAK83VWa75EvkQpDF1xDY4d43GAxXwdh5DhyEQ66xC3zHbwKgkwBgT6MZEgjCUG9Rqc9LQkXAoj9GopLM59",
      spendBase58: "WmeeEzLLdekdNHK7zjR6SMsTs5tTGdx834",
      scanPubkey:
        "035393fef4c915bc3da87dbea4cb89d1309cdf1a582a5b5e99b966f93d709e8e68",
      spendPubkey:
        "026b58f67069483d4573e7c64860ca4dfca835758d794e739fd2cf8684a532c2a9",
    },
  ];

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

  test("pinned indexes match the wallet-lib committed shielded fixture (source of truth)", () => {
    const pairs = generateShieldedAddresses(GENESIS_SEED);
    for (const expected of EXPECTED_ENTRIES) {
      expect(pairs[expected.bip32AddressIndex]).toEqual(expected);
    }
  });

  // The pinned entries above cover three indexes; this covers the rest by
  // rejecting duplicates, so a helper that derived one child key for every
  // index cannot pass on the strength of index 0 alone.
  test("every index derives a distinct pair", () => {
    const pairs = generateShieldedAddresses(GENESIS_SEED);
    expect(new Set(pairs.map((p) => p.shieldedBase58)).size).toBe(
      config.ADDRESS_COUNT,
    );
    expect(new Set(pairs.map((p) => p.spendBase58)).size).toBe(
      config.ADDRESS_COUNT,
    );
  });

  test("is deterministic: same seed derives byte-identical pairs", () => {
    expect(generateShieldedAddresses(GENESIS_SEED)).toEqual(
      generateShieldedAddresses(GENESIS_SEED),
    );
  });

  test("generateSimpleWallet populates shieldedAddresses from its own seed", () => {
    const w = generateSimpleWallet();
    expect(w.shieldedAddresses).toHaveLength(config.ADDRESS_COUNT);
    for (const p of w.shieldedAddresses!) {
      expect(Object.keys(p).sort()).toEqual(EXPECTED_KEYS);
    }
    // Shape alone would pass on pairs derived from an unrelated seed, which
    // would hand callers shielded addresses this wallet cannot spend.
    expect(w.shieldedAddresses).toEqual(generateShieldedAddresses(w.words));
  });
});

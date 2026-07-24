import hathorLib from "@hathor/wallet-lib";
// Type-only import: erased at compile time, so it adds no runtime import and
// cannot perturb wallet-lib's module load order. Mirrors the Lib's shielded
// precalculated-address contract so drift becomes a compile error here — see
// PrecalculatedShieldedAddress below.
import type { IPrecalculatedShieldedAddress } from "@hathor/wallet-lib/lib/types";
import { config } from "./config";

// The shielded account-path constants come off hathorLib.constants.
// `deriveShieldedAddress` is not re-exported from the package barrel, so it has
// to be reached by deep path; we require it lazily at call time (inside
// generateShieldedAddresses, below) rather than deep-importing it at module load.
// What the lazy require buys is call-time deferral, NOT load ordering: the
// `import hathorLib` above is evaluated first regardless, so the barrel and its
// transitive graph are already initialised before any deep import would run.
// The circular transaction<->create_token_transaction dependency that once broke
// this repo's Bun CI with `TypeError: The superclass is not a constructor` is
// fixed at the source in wallet-lib 4.1.0 (#1137 makes those classes lazy), so
// on 4.1.0 the deep import is safe either way — the lazy require just keeps this
// module's load cheap.
const { walletUtils, addressUtils, config: hathorConfig, constants } = hathorLib;

// wallet-lib reads the network from its own module-level state during
// address derivation. Pin it once at import time so callers don't have
// to thread it through every API call.
hathorConfig.setNetwork(config.NETWORK);

/**
 * A pre-calculated shielded address pair, one per BIP32 index. Aliased directly
 * to wallet-lib's `IPrecalculatedShieldedAddress` (rather than hand-redeclared)
 * so the payload is a provable drop-in for the Lib's `preCalculatedShieldedAddresses`
 * wallet option: a rename or added field on the Lib side becomes a compile error
 * here instead of silently-wrong output on the wire. The Lib type documents each
 * field (shieldedBase58 / spendBase58 / scanPubkey / spendPubkey).
 */
export type PrecalculatedShieldedAddress = IPrecalculatedShieldedAddress;

export interface SimpleWallet {
  words: string;
  addresses: string[];
  // Optional so consumers on older wallet-lib versions (no shielded support)
  // stay compatible; generateSimpleWallet always populates it.
  shieldedAddresses?: PrecalculatedShieldedAddress[];
}

// Mirrors the `multisigDebugData` field of wallet-lib's
// `PrecalculatedWalletData` (hathor-wallet-lib
// __tests__/integration/helpers/wallet-precalculation.helper.ts) so the
// helper is a drop-in for the Lib's precalculated multisig wallets. Keep
// these field names aligned with that contract.
export interface MultisigDebugData {
  total: number;
  minSignatures: number;
  pubkeys: string[];
}

export interface MultisigWallet {
  words: string;
  addresses: string[];
  multisigDebugData: MultisigDebugData;
}

/**
 * Generate a fresh simple wallet: a random 24-word BIP39 seed and a
 * deterministic list of P2PKH addresses derived from it.
 *
 * Returns ADDRESS_COUNT addresses at indices [0, ADDRESS_COUNT) under
 * the change derivation path (m/44'/280'/0'/0).
 */
/**
 * Derive the shielded scan/spend address pairs for a seed, matching what
 * wallet-lib's shielded branch derives live. The scan (account 1') and spend
 * (account 2') account xpubs are derived with COMPLIANT `deriveChild` — the
 * per-index shielded address is then produced by wallet-lib's own
 * `deriveShieldedAddress`. Returns ADDRESS_COUNT pairs at indices
 * [0, ADDRESS_COUNT).
 */
export function generateShieldedAddresses(
  words: string,
): PrecalculatedShieldedAddress[] {
  // Lazy require, deferred to call time — see the note by the imports above.
  // The deep path is version-pinned to the wallet-lib 4.1.0 in package.json;
  // `deriveShieldedAddress` is not on the package barrel yet.
  const { deriveShieldedAddress } = require("@hathor/wallet-lib/lib/utils/shieldedAddress.js");
  const rootXpriv = walletUtils.getXPrivKeyFromSeed(words, {
    networkName: config.NETWORK,
  });
  const scanXpub = rootXpriv
    .deriveChild(constants.SHIELDED_SCAN_ACCT_PATH)
    .deriveChild(0).xpubkey;
  const spendXpub = rootXpriv
    .deriveChild(constants.SHIELDED_SPEND_ACCT_PATH)
    .deriveChild(0).xpubkey;

  const shieldedAddresses: PrecalculatedShieldedAddress[] = [];
  for (let i = 0; i < config.ADDRESS_COUNT; i++) {
    const info = deriveShieldedAddress(scanXpub, spendXpub, i, config.NETWORK);
    // The deep require is untyped (`any`), so nothing catches a renamed or
    // dropped field at compile time. Assert the shape at generation time —
    // otherwise a drifted field would serialize to the wire as `undefined` and
    // surface as an opaque failure deep inside a consuming wallet.
    for (const field of [
      "base58",
      "spendAddress",
      "scanPubkey",
      "spendPubkey",
    ] as const) {
      if (typeof info[field] !== "string" || info[field].length === 0) {
        throw new Error(
          `deriveShieldedAddress returned an unexpected shape at index ${i}: ` +
            `\`${field}\` is missing or not a non-empty string — the deep import ` +
            `@hathor/wallet-lib/lib/utils/shieldedAddress.js has likely drifted ` +
            `from the pinned 4.1.0 contract.`,
        );
      }
    }
    shieldedAddresses.push({
      bip32AddressIndex: i,
      shieldedBase58: info.base58,
      spendBase58: info.spendAddress,
      scanPubkey: info.scanPubkey,
      spendPubkey: info.spendPubkey,
    });
  }
  return shieldedAddresses;
}

export function generateSimpleWallet(): SimpleWallet {
  const words = walletUtils.generateWalletWords();

  const xpub = walletUtils.getXPubKeyFromSeed(words, {
    accountDerivationIndex: "0'/0",
    networkName: config.NETWORK,
  });

  const addresses: string[] = [];
  for (let i = 0; i < config.ADDRESS_COUNT; i++) {
    const info = addressUtils.deriveAddressFromXPubP2PKH(
      xpub,
      i,
      config.NETWORK,
    );
    addresses.push(info.base58);
  }
  return { words, addresses, shieldedAddresses: generateShieldedAddresses(words) };
}

/**
 * Generate a complete N-of-M multisig wallet set.
 *
 * Each participant gets their own BIP39 seed but all participants
 * derive the same P2SH addresses, so any subset of size `numSignatures`
 * can co-sign. Pubkeys are sorted lexicographically before derivation
 * to make the shared address set independent of seed-generation order.
 *
 * Returns an array of `participants` wallets — the caller (test
 * harness) is responsible for distributing each entry to the right
 * peer.
 */
export function generateMultisigWallet(
  participants: number,
  numSignatures: number,
): MultisigWallet[] {
  const allWords: string[] = [];
  const pubkeys: string[] = [];

  for (let i = 0; i < participants; i++) {
    const words = walletUtils.generateWalletWords();
    allWords.push(words);
    const xpub = walletUtils.getMultiSigXPubFromWords(words, {
      networkName: config.NETWORK,
    });
    pubkeys.push(xpub);
  }

  const sortedPubkeys = [...pubkeys].sort();
  const multisigData = { pubkeys: sortedPubkeys, numSignatures };

  const sharedAddresses: string[] = [];
  for (let i = 0; i < config.ADDRESS_COUNT; i++) {
    const info = addressUtils.deriveAddressFromDataP2SH(
      multisigData,
      i,
      config.NETWORK,
    );
    sharedAddresses.push(info.base58);
  }

  // Each returned wallet gets its own copy of the shared arrays. The
  // P2SH addresses and pubkey list are identical across participants by
  // design, but sharing the underlying array references would let a
  // downstream mutation on one wallet leak into the others. Spreading is
  // O(N × ADDRESS_COUNT) and run at generation time, so the cost is
  // negligible — but the aliasing surprise it prevents would be a nasty
  // heisenbug.
  //
  // The full participant seed set is intentionally NOT embedded in each
  // wallet's multisigDebugData: every returned wallet already carries its
  // own `words`, so callers needing the whole set use `wallets.map(w =>
  // w.words)` rather than receiving N duplicated copies.
  return allWords.map((words) => ({
    words,
    addresses: [...sharedAddresses],
    multisigDebugData: {
      total: participants,
      minSignatures: numSignatures,
      pubkeys: [...sortedPubkeys],
    },
  }));
}

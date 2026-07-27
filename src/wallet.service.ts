import hathorLib from "@hathor/wallet-lib";
import type { IPrecalculatedShieldedAddress } from "@hathor/wallet-lib/lib/types";
import { config } from "./config";

// `deriveShieldedAddress` isn't on the package barrel; it's required lazily
// inside generateShieldedAddresses to keep this module's load cheap.
const { walletUtils, addressUtils, config: hathorConfig, constants } = hathorLib;

// wallet-lib reads the network from its own module-level state during
// address derivation. Pin it once at import time so callers don't have
// to thread it through every API call.
hathorConfig.setNetwork(config.NETWORK);

/** Alias, not a redeclaration: a Lib-side rename becomes a compile error here. */
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
  // Deep path: `deriveShieldedAddress` isn't exported from the package barrel.
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
    // The deep require is untyped, so a renamed field would reach the wire as
    // `undefined` and fail opaquely inside a consuming wallet. Check it here.
    for (const field of [
      "base58",
      "spendAddress",
      "scanPubkey",
      "spendPubkey",
    ] as const) {
      if (typeof info[field] !== "string" || info[field].length === 0) {
        throw new Error(
          `deriveShieldedAddress: \`${field}\` missing or not a non-empty string at index ${i}`,
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

/**
 * Generate a fresh simple wallet: a random 24-word BIP39 seed, the
 * P2PKH addresses derived from it (indices [0, ADDRESS_COUNT) under
 * m/44'/280'/0'/0), and the matching shielded pairs.
 */
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

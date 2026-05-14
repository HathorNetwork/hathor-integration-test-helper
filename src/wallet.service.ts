import hathorLib from "@hathor/wallet-lib";
import { config } from "./config";

const { walletUtils, addressUtils, config: hathorConfig } = hathorLib;

// wallet-lib reads the network from its own module-level state during
// address derivation. Pin it once at import time so callers don't have
// to thread it through every API call.
hathorConfig.setNetwork(config.NETWORK);

export interface SimpleWallet {
  words: string;
  addresses: string[];
}

export interface MultisigDebugData {
  words: string[];
  total: number;
  numSignatures: number;
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
  return { words, addresses };
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

  return allWords.map((words) => ({
    words,
    addresses: sharedAddresses,
    multisigDebugData: {
      words: allWords,
      total: participants,
      numSignatures,
      pubkeys: sortedPubkeys,
    },
  }));
}

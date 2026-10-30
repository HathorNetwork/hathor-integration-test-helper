import hathorLib from "@hathor/wallet-lib";
import { config } from "./config";

const { Address, Network } = hathorLib;
export const network = new Network(config.NETWORK);

/**
 * Validate a base58 Hathor address against the configured network.
 * Accepts legacy (P2PKH/P2SH) and shielded addresses.
 * Returns false for malformed or wrong-network addresses.
 */
export function isValidHathorAddress(address: string): boolean {
  try {
    const parsed = new Address(address, { network });
    return parsed.isValid();
  } catch {
    return false;
  }
}


/** True when `address` is a valid shielded address on the configured network. */
export function isShieldedHathorAddress(address: string): boolean {
  try {
    const parsed = new Address(address, { network });
    return parsed.isValid() && parsed.isShielded();
  } catch {
    return false;
  }
}

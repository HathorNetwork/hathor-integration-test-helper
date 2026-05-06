import hathorLib from "@hathor/wallet-lib";
import { config } from "./config";

const { Address, Network } = hathorLib;
const network = new Network(config.NETWORK);

/**
 * Validate a base58 Hathor address against the configured network.
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


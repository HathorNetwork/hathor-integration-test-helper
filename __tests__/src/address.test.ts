import { describe, test, expect } from "bun:test";
import { isValidHathorAddress } from "../../src/address";

describe("isValidHathorAddress", () => {
  test("rejects empty string", () => {
    expect(isValidHathorAddress("")).toBe(false);
  });

  test("rejects garbage strings", () => {
    expect(isValidHathorAddress("not-an-address")).toBe(false);
    expect(isValidHathorAddress("a")).toBe(false);
    expect(isValidHathorAddress("123abc")).toBe(false);
  });

  test("rejects mainnet addresses on testnet", () => {
    // Hathor mainnet addresses start with 'H'; testnet uses 'W'. This
    // assertion fires through the wallet-lib's Address constructor and
    // is the main regression detector for a wallet-lib upgrade that
    // breaks the constructor signature: a totally-broken constructor
    // would either throw on every input (the catch returns false here,
    // false for everything) — caught by the positive test below — or
    // return true for everything — caught by this negative.
    expect(isValidHathorAddress("HMPDdRfZbDDgK2vfGAXLUuVNK52pZRNNrr")).toBe(false);
  });

  test("accepts a well-formed testnet address", () => {
    // Known-good testnet address generated against wallet-lib 3.0.1.
    // Pinning a positive case here means a wallet-lib upgrade that
    // breaks `new Address(s, {network})` or `.isValid()` flips this
    // test red, instead of silently downgrading every wallet endpoint
    // in PR2 to "INVALID_REQUEST".
    expect(isValidHathorAddress("WewDeXWyvHP7jJTs7tjLoQfoB72LLxJQqN")).toBe(true);
  });
});

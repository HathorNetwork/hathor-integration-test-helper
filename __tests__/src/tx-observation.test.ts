import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { awaitTxObserved, type TxObservationWallet } from "../../src/tx-observation";

function makeMockWallet(opts: {
  knownTxIds?: Set<string>;
  getTxThrows?: boolean;
} = {}): TxObservationWallet & EventEmitter {
  const known = opts.knownTxIds ?? new Set<string>();
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    async getTx(id: string) {
      if (opts.getTxThrows) throw new Error("getTx blew up");
      return known.has(id) ? { id } : null;
    },
  });
}

describe("awaitTxObserved", () => {
  test("returns true immediately when getTx already knows the tx", async () => {
    const wallet = makeMockWallet({ knownTxIds: new Set(["tx-1"]) });
    expect(await awaitTxObserved(wallet, "tx-1", 1_000)).toBe(true);
  });

  test("returns true when 'new-tx' fires with the matching tx_id", async () => {
    const wallet = makeMockWallet();
    const promise = awaitTxObserved(wallet, "tx-2", 1_000);

    // Simulate the wallet's WS pipeline emitting the spending tx.
    setImmediate(() => wallet.emit("new-tx", { tx_id: "tx-2" }));

    expect(await promise).toBe(true);
    // The listener must be torn down on resolve — otherwise every call leaks a
    // 'new-tx' handler on the long-lived genesis wallet.
    expect(wallet.listenerCount("new-tx")).toBe(0);
  });

  test("returns false when timeout elapses without observation", async () => {
    const wallet = makeMockWallet();
    expect(await awaitTxObserved(wallet, "tx-3", 50)).toBe(false);
    // Same cleanup guarantee on the timeout path.
    expect(wallet.listenerCount("new-tx")).toBe(0);
  });

  test("does not resolve on a 'new-tx' event for a different txId", async () => {
    const wallet = makeMockWallet();
    const promise = awaitTxObserved(wallet, "tx-4", 80);

    // Emit several unrelated tx events; should still time out.
    wallet.emit("new-tx", { tx_id: "other-1" });
    wallet.emit("new-tx", { tx_id: "other-2" });

    expect(await promise).toBe(false);
  });

  test("catches a 'new-tx' that fires while getTx is still in flight", async () => {
    // getTx resolves null only after a delay; the event fires during that
    // window. If the listener were registered only after getTx resolved (the
    // old ordering), this observation would be missed and the call would time
    // out instead of resolving true.
    const emitter = new EventEmitter();
    const wallet = Object.assign(emitter, {
      async getTx() {
        await new Promise((r) => setTimeout(r, 30));
        return null;
      },
    }) as unknown as TxObservationWallet & EventEmitter;

    const promise = awaitTxObserved(wallet, "tx-race", 1_000);
    // Fire synchronously, before the slow getTx resolves.
    wallet.emit("new-tx", { tx_id: "tx-race" });

    expect(await promise).toBe(true);
  });

  test("survives getTx throwing and falls through to event/timeout path", async () => {
    const wallet = makeMockWallet({ getTxThrows: true });
    const promise = awaitTxObserved(wallet, "tx-5", 100);
    setImmediate(() => wallet.emit("new-tx", { tx_id: "tx-5" }));
    expect(await promise).toBe(true);
  });
});

/**
 * Bootstrap entry point. Wired incrementally by subsequent PRs:
 * - PR2 wires `initializeCache()` and the wallet/multisig/live routes.
 * - PR3 wires `bootstrapFunding()` and the readiness/status routes.
 * - PR5 wires the /fund and /metrics routes.
 */
import { applyWalletLibBigIntPatch } from "./src/bigint-patch";

applyWalletLibBigIntPatch();

const PORT = Number(process.env.PORT ?? "3020");

const server = Bun.serve({
  port: PORT,
  fetch() {
    return Response.json({ alive: true });
  },
});

console.log(
  JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    event: "server.started",
    port: server.port,
  }),
);

/**
 * Bootstrap entry point. Wired incrementally by subsequent PRs:
 * - PR2 wires `initializeCache()` and the `/simpleWallet`, `/multisigWallet`,
 *   and `/live` routes.
 * - The genesis/readiness layer wires `bootstrapFunding()` plus the
 *   `/status` and `/ready` routes.
 * - The funding PRs wire the `/fund` and `/metrics` routes.
 */
import { config } from "./src/config";
import { logger } from "./src/logger";
import { initializeCache } from "./src/wallet.cache";
import { bootstrapFunding } from "./src/startup";
import { createRoutes } from "./src/app";
import { setupSignalHandlers } from "./src/signal-handlers";

initializeCache();

// Fire-and-forget: the genesis wallet syncs in the background so the HTTP
// server starts serving wallet endpoints immediately. Readiness is reported
// via /ready and /status as the bootstrap progresses.
void bootstrapFunding();

const server = Bun.serve({
  port: config.PORT,
  routes: createRoutes(),
});

setupSignalHandlers(server);

logger.info({
  event: "server.started",
  meta: { port: server.port },
});

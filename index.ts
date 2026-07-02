/**
 * Bootstrap entry point. Wires the service startup sequence:
 * - `initializeCache()` and the `/simpleWallet`, `/multisigWallet`, and
 *   `/live` routes.
 * - `bootstrapFunding()` plus the `/status` and `/ready` routes.
 * - The `/fund` and `/metrics` routes are not wired yet.
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

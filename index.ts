/**
 * Bootstrap entry point. Wired incrementally by subsequent PRs:
 * - PR2 wires `initializeCache()` and the `/simpleWallet`, `/multisigWallet`,
 *   and `/live` routes.
 * - PR3 will wire `bootstrapFunding()` plus the `/status` and `/ready` routes.
 * - PR5 will wire the `/fund` and `/metrics` routes.
 */
import { config } from "./src/config";
import { logger } from "./src/logger";
import { initializeCache } from "./src/wallet.cache";
import { createRoutes } from "./src/app";
import { setupSignalHandlers } from "./src/signal-handlers";

initializeCache();

const server = Bun.serve({
  port: config.PORT,
  routes: createRoutes(),
});

setupSignalHandlers(server);

logger.info({
  event: "server.started",
  meta: { port: server.port },
});

/**
 * Bootstrap entry point. Wired incrementally by subsequent PRs:
 * - PR2 wires `initializeCache()` and the `/simpleWallet`, `/multisigWallet`,
 *   and `/live` routes.
 * - PR3 wires `bootstrapFunding()` and the `/status` and `/ready` routes.
 * - PR5 wires the `/fund` and `/metrics` routes.
 */
import { config } from "./src/config";
import { logger } from "./src/logger";

const server = Bun.serve({
  port: config.PORT,
  fetch() {
    return Response.json({ alive: true });
  },
});

logger.info({
  event: "server.started",
  meta: { port: server.port },
});

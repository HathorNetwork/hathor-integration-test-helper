/**
 * Bootstrap entry point. Wires the service startup sequence:
 * - `initializeCache()` and the `/simpleWallet`, `/multisigWallet`, and
 *   `/live` routes.
 * - `bootstrapFunding()` plus the `/status` and `/ready` routes.
 * - The `/fund` and `/metrics` routes.
 */
import { config } from "./src/config";
import { logger } from "./src/logger";
import { initializeCache } from "./src/wallet.cache";
import { bootstrapFunding } from "./src/startup";
import { createRoutes, handleNotFound } from "./src/app";
import { setupSignalHandlers } from "./src/signal-handlers";

initializeCache();

// Fire-and-forget: the genesis wallet syncs in the background so the HTTP
// server starts serving wallet endpoints immediately. Readiness is reported
// via /ready and /status as the bootstrap progresses.
void bootstrapFunding();

const server = Bun.serve({
  port: config.PORT,
  routes: createRoutes(),
  // Unknown path, or a known path with a method its route object doesn't
  // define: Bun's built-in 404 has an empty body, which would break the RFC's
  // "every failure carries {error, message, retryable}" contract.
  fetch: handleNotFound,
  // Backstop only. parseFundBody rejects an oversized body itself (with the
  // RFC envelope) using the declared content-length, so this cap sits above
  // MAX_REQUEST_BODY_BYTES and catches the case that check cannot: a client
  // that understates content-length or streams chunked. Bun's own default is
  // 128 MB, far above anything this service should buffer.
  maxRequestBodySize: config.MAX_REQUEST_BODY_BYTES * 2,
});

setupSignalHandlers(server);

logger.info({
  event: "server.started",
  meta: { port: server.port },
});

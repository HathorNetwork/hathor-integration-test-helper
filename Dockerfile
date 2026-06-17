# Stage 1: Install dependencies
FROM oven/bun:1 AS deps
WORKDIR /app
# The patch file and bunfig must be present before install: package.json's
# `patchedDependencies` points at patches/, and `bun install` applies it then.
# Without the patch, install fails (frozen lockfile) or wallet-lib ships
# unpatched.
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production

# Stage 2: Production image
FROM oven/bun:1-slim AS runner
WORKDIR /app

# Copy dependencies and source
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY index.ts ./

# Runtime configuration. NETWORK, HATHOR_NODE_URL, TX_MINING_URL and
# GENESIS_SEED_WORDS intentionally rely on src/config.ts defaults, which are
# kept equal to hathor-wallet-lib's integration test-constants — so the image
# is plug-and-play for the Lib CI. Override any at `docker run` time
# (`-e HATHOR_NODE_URL=...`) for other deployments. Do NOT set them to empty
# strings here: that would clobber the good defaults.
ENV NODE_ENV=production
ENV PORT=3020
EXPOSE 3020

CMD ["bun", "run", "index.ts"]

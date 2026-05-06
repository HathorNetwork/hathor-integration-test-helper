# Stage 1: Install dependencies
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 2: Production image
FROM oven/bun:1-slim AS runner
WORKDIR /app

# Copy dependencies and source
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY index.ts ./

# Runtime configuration
ENV NODE_ENV=production
ENV PORT=3020
ENV GENESIS_SEED_WORDS=""
ENV HATHOR_NODE_URL=""
EXPOSE 3020

CMD ["bun", "run", "index.ts"]

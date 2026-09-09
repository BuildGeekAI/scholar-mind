# --- Build stage ------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The server runs from TypeScript via tsx (a runtime dependency), which keeps a
# single source of truth rather than adding a separate server bundling step.
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY types.ts ./types.ts

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8080

# The API server. The queue worker runs from this same image with its command
# overridden (`npx tsx server/worker.ts`) — one image, two services, so the
# worker can never drift from the pipeline code the API enqueues against.
CMD ["npx", "tsx", "server/index.ts"]

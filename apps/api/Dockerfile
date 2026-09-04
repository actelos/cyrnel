FROM node:24-slim AS builder
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./

COPY apps/api/package.json apps/api/package.json
COPY packages/libs/sdk/package.json packages/libs/sdk/package.json
COPY packages/modules/openapi/package.json packages/modules/openapi/package.json
COPY packages/modules/typescript-ivm/package.json packages/modules/typescript-ivm/package.json

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/ apps/

RUN pnpm turbo build --filter=@cyrnel/api
RUN pnpm deploy --filter=@cyrnel/api --prod --legacy /tmp/deploy

FROM node:24-slim
WORKDIR /app
COPY --from=builder /tmp/deploy .
COPY --from=builder /app/apps/api/drizzle ./drizzle/

ENV NODE_ENV=production
ENV PORT=9371
ENV SHUTDOWN_TIMEOUT_MS=10000
ENV LOG_LEVEL=info
ENV CYRNEL_DATA_DIR=/data
ENV CYRNEL_API_KEY=
ENV CYRNEL_SECRETS_KEY=
ENV CYRNEL_SECRETS_PREVIOUS_KEYS=
ENV CYRNEL_LOG_ROTATION_MB=10
ENV CYRNEL_LOG_MAX_FILES=5
ENV CYRNEL_LOG_RING_BUFFER=10000
ENV CYRNEL_LOG_DEDUPE_WINDOW_MS=0
ENV CYRNEL_ALLOWED_IPS=
ENV CYRNEL_BLOCKED_IPS=
ENV CYRNEL_REGISTRY_ALLOWED_IPS=
ENV CYRNEL_REGISTRY_BLOCKED_IPS=
ENV CYRNEL_BLOCK_ALL_REGISTRIES=false
ENV CYRNEL_DEFAULT_REGISTRY_URL=
ENV CYRNEL_RATE_LIMIT_MAX=
ENV CYRNEL_RATE_LIMIT_WINDOW_MS=
ENV CYRNEL_MAX_CONNECTIONS=0
ENV CYRNEL_KEEPALIVE_TIMEOUT_MS=5000
ENV CYRNEL_HEADERS_TIMEOUT_MS=6000
ENV CYRNEL_REQUEST_TIMEOUT_MS=0
ENV CYRNEL_MAX_ACTIVE_PROCESSES=1000
ENV CYRNEL_MAX_IDLE_PROCESSES=
ENV CYRNEL_MAX_CODE_SIZE_BYTES=102400
ENV CYRNEL_INVOKE_TIMEOUT_MS=30000
ENV CYRNEL_EMBEDDING_MODEL=Xenova/bge-small-en-v1.5
ENV CYRNEL_RECONCILE_INTERVAL_MS=1800000
ENV CYRNEL_AUTO_UPDATE_INTERVAL_MS=0
ENV CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS=
ENV CYRNEL_APPROVAL_TIMEOUT_MS=300000
ENV CYRNEL_APPROVAL_RETENTION_MS=2592000000

EXPOSE 9371
VOLUME ["/data"]
CMD node dist/migrate.js && node dist/index.js

FROM node:24-alpine AS builder
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

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /tmp/deploy .
COPY --from=builder /app/apps/api/drizzle ./drizzle/

ENV NODE_ENV=production
ENV PORT=9371
ENV SHUTDOWN_TIMEOUT_MS=10000
ENV LOG_LEVEL=info
ENV CYRNEL_DATA_DIR=/data
ENV CYRNEL_DB_URL=
ENV CYRNEL_API_KEY=
ENV CYRNEL_SECRETS_KEY=
ENV CYRNEL_ALLOWED_IPS=
ENV CYRNEL_BLOCKED_IPS=
ENV CYRNEL_BLOCK_ALL_REGISTRIES=false

EXPOSE 9371
VOLUME ["/data"]
CMD node dist/migrate.js && node dist/index.js

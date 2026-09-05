FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./

COPY apps/mcp/package.json apps/mcp/package.json

RUN pnpm install --frozen-lockfile

COPY apps/mcp/ apps/mcp/

RUN pnpm turbo build --filter=@cyrnel/mcp
RUN pnpm deploy --filter=@cyrnel/mcp --prod --legacy /tmp/deploy

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /tmp/deploy .

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=9373
ENV CYRNEL_API_URL=http://api:9371
ENV CYRNEL_API_TIMEOUT_MS=30000

EXPOSE 9373
CMD ["node", "dist/index.js"]

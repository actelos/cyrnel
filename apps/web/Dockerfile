FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./

COPY apps/web/package.json apps/web/package.json
COPY packages/libs/sdk/package.json packages/libs/sdk/package.json

RUN pnpm install --frozen-lockfile

ARG VITE_CYRNEL_API_URL=

COPY apps/web/ apps/web/
COPY packages/libs/sdk/ packages/libs/sdk/

RUN pnpm turbo build --filter=@cyrnel/web
RUN pnpm deploy --filter=@cyrnel/web --prod --legacy /tmp/deploy

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /tmp/deploy .

ENV NODE_ENV=production
ENV PORT=9372
ENV HOST=0.0.0.0
ENV CYRNEL_API_URL=http://api:9371

EXPOSE 9372
CMD ["node", "dist/server/index.js"]

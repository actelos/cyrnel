FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./

COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

ARG VITE_AUTH_USERNAME=
ARG VITE_AUTH_PASSWORD=
ARG VITE_CYRNEL_API_URL=http://127.0.0.1:7687
ARG VITE_CYRNEL_API_KEY=

COPY apps/web/ apps/web/

RUN pnpm turbo build --filter=@cyrnel/web
RUN pnpm deploy --filter=@cyrnel/web --prod --legacy /tmp/deploy

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /tmp/deploy .

ENV NODE_ENV=production
ENV PORT=4173
ENV HOST=0.0.0.0
ENV CYRNEL_API_URL=http://api:7687
ENV CYRNEL_API_KEY=


EXPOSE 4173
CMD ["node", "dist/server/index.js"]

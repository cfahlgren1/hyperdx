ARG NODE_VERSION=22.22

FROM node:${NODE_VERSION}-alpine AS base

WORKDIR /app

COPY .yarn ./.yarn
COPY .yarnrc.yml yarn.lock package.json nx.json tsconfig.base.json ./
COPY packages/agent/package.json packages/agent/package.json

RUN --mount=type=cache,target=/root/.yarn/berry/cache,id=agent-yarn-cache \
    yarn install --mode=skip-build

FROM base AS builder

COPY packages/agent packages/agent
RUN yarn workspace @hyperdx/agent build
RUN rm -rf node_modules && yarn workspaces focus @hyperdx/agent --production

FROM node:${NODE_VERSION}-alpine AS production

ENV NODE_ENV=production
ENV PORT=4010

WORKDIR /app

RUN mkdir -p /data && chown node:node /data

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages/agent/package.json ./packages/agent/package.json
COPY --chown=node:node --from=builder /app/packages/agent/dist ./packages/agent/dist

USER node
WORKDIR /app/packages/agent

EXPOSE 4010

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.mjs"]

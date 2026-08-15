ARG NODE_IMAGE=node:20
FROM ${NODE_IMAGE} AS builder

ARG NPM_REGISTRY=https://registry.npmjs.org

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
ENV CI=true
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
ENV npm_config_registry=$NPM_REGISTRY
ENV pnpm_config_registry=$NPM_REGISTRY

RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ais-relay/package.json apps/ais-relay/tsconfig.json apps/ais-relay/tsconfig.build.json apps/ais-relay/tsconfig.typecheck.json /workspace/apps/ais-relay/
COPY apps/ais-relay/src /workspace/apps/ais-relay/src
COPY packages/config/tsconfig/base.json /workspace/packages/config/tsconfig/base.json

RUN pnpm install --unsafe-perm --filter @modular/ais-relay... --frozen-lockfile
RUN pnpm --filter @modular/ais-relay run build
RUN pnpm --filter @modular/ais-relay deploy --prod /opt/ais-relay

FROM ${NODE_IMAGE} AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /opt/ais-relay /app

USER node
CMD ["node", "dist/index.js"]

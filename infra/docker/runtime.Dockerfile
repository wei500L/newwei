ARG NODE_IMAGE=node:20
FROM ${NODE_IMAGE} AS builder

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NEXTAUTH_URL=http://localhost:3000
ARG NEXTAUTH_SECRET=change_me_please_replace_32_chars
ARG API_BASE_URL=http://api:4000
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api

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
ENV NEXTAUTH_URL=$NEXTAUTH_URL
ENV NEXTAUTH_SECRET=$NEXTAUTH_SECRET
ENV API_BASE_URL=$API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_BUILD_SKIP_QUALITY_CHECKS=true

RUN corepack enable

WORKDIR /workspace

COPY . .

RUN pnpm install --unsafe-perm --frozen-lockfile
RUN pnpm rebuild bcrypt --unsafe-perm
RUN DATABASE_URL=mysql://root:secret@mysql:3306/app \
    MYSQL_HOST=mysql \
    MYSQL_PORT=3306 \
    MYSQL_USER=root \
    MYSQL_PASSWORD=secret \
    MYSQL_DB=app \
    pnpm --filter @modular/db run prisma:generate
RUN pnpm --filter @modular/api run generate:schema
RUN pnpm exec turbo run build --env-mode=loose --filter=@modular/ais-relay --filter=@modular/api --filter=@modular/vector --filter=@modular/web

FROM ${NODE_IMAGE} AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
ENV CI=true
ENV NODE_ENV=production

RUN corepack enable

WORKDIR /workspace

COPY --from=builder /workspace /workspace

ARG NODE_IMAGE=node:20
FROM ${NODE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace

EXPOSE 3000
USER node
CMD ["pnpm", "--filter", "@modular/web", "run", "dev:turbo"]

FROM node:20

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY infra ./infra

RUN pnpm install --recursive --ignore-scripts

EXPOSE 3000
CMD ["pnpm", "--filter", "@modular/web", "run", "dev", "--", "--hostname", "0.0.0.0"]

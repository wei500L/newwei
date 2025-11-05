# newwei

A pnpm + Turborepo workspace that stitches together a Next.js admin console and a NestJS backend. The stack is wired as a modular monolith featuring RBAC, authentication, queues, SQL + Mongo persistence, and dockerised local development.

## Tech Stack

- **Frontend**: Next.js 15 (App Router), React 18, Ant Design 5, Apollo Client, GraphQL Code Generator, ECharts, TanStack Query, Zustand, Auth.js (NextAuth)
- **Backend**: NestJS 11, Apollo GraphQL (code-first), Prisma (MySQL), Mongoose (MongoDB), BullMQ (Redis), class-validator, OpenAPI/Swagger
- **Tooling**: pnpm 9, Turborepo, TypeScript strict mode, Zod env validation, Husky + lint-staged + Commitlint

## Getting Started

```bash
# Install dependencies and prepare Husky hooks
cp .env.example .env
cp infra/docker/.env.sample infra/docker/.env
pnpm install
pnpm prepare

# Validate environment configuration
pnpm --filter infra-scripts run env:check

# Apply Prisma schema and seed sample data
pnpm db:migrate
pnpm db:seed

# Start Next.js + NestJS concurrently
pnpm dev
```

Navigate to:
- Frontend: http://localhost:3000/login
- API health: http://localhost:4000/api/healthz
- Swagger UI: http://localhost:4000/docs
- GraphQL Playground (dev): http://localhost:4000/graphql

Seeded admin credentials: `admin@example.com` / `Change_me123!`

### Docker Compose

```bash
cp infra/docker/.env.sample infra/docker/.env
pnpm docker:up   # launches MySQL, Mongo, Redis, API, Web
pnpm docker:logs # tail the stack
pnpm docker:down
```

Services are defined in `infra/docker/docker-compose.yml` with health checks and volume mounts for hot reload. Containers run `pnpm install` on boot, so the first start may take a moment.

## Workspace Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Runs `@modular/api` and `@modular/web` in watch mode |
| `pnpm build` | Turbo build across all packages |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Aggregate lint, type check, and tests |
| `pnpm db:migrate` | Executes Prisma migrations via `packages/db` |
| `pnpm db:seed` | Seeds default organisation, roles, and admin user |
| `pnpm docker:*` | Wraps docker-compose lifecycle (infra/scripts) |

Key package scripts:
- `apps/api`: `dev`, `build`, `test`, `test:e2e`
- `apps/web`: `dev`, `build`, `start`, `typecheck`
- `infra/scripts`: `env:check`, `docker:up`, `docker:down`, `docker:logs`

## Code Structure

```
apps/
  api/   # NestJS service (auth, rbac, queue, items, swagger, graphql)
  web/   # Next.js admin console with NextAuth credentials provider
packages/
  config/  # shared tsconfig/eslint/prettier + RBAC seed data
  db/      # Prisma schema, migrations, seed helpers
  mongo/   # Mongoose models and connection helpers
  utils/   # Zod env loader, logger, formatting utilities
infra/
  docker/  # docker-compose, env samples, dev Dockerfiles
  scripts/ # helper scripts (env check, compose wrappers)
```

## Testing

- Unit tests for auth and RBAC services (`pnpm --filter @modular/api test`)
- E2E smoke tests via Supertest covering `/api/healthz` and `/api/auth/login`

## Swagger & RBAC

- Swagger docs exposed at `/docs`
- Global JWT and permission guards; use `@Permissions(...)` to protect routes
- Seeded roles and permissions come from `packages/config/src/rbac.ts`

## TODO & Extension Points

- [ ] Implement refresh-token blacklisting beyond simple revocation
- [ ] Add frontend component tests (Playwright or Vitest)
- [ ] Replace placeholder dashboard narrative card with real analytics once metrics stack is connected
- [ ] Hook BullMQ task events into WebSockets for real-time UI updates

Feel free to adapt the docker workflow (for example, switching to production-style multi-stage images) or extend the seed data to fit your organisation model.

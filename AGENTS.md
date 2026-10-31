# Repository Guidelines

## Backend Migration Navigation

进行后端迁移规划或相关进度更新前，先读取 [迁移地图入口](docs/refactor/migration-map/README.md) 和 [规划规则](docs/refactor/migration-map/PLANNING.md)。

## Project Structure & Module Organization

This pnpm + Turborepo workspace splits runtime apps under `apps/`: `apps/api-go` is the (only) backend gateway (Go, REST + GraphQL + WebSocket + workers), `apps/vector-go` the vector service, and `apps/web` powers the Next.js console. The former NestJS `apps/api`, Node `apps/vector`, and `apps/ais-relay` have been removed; rolling back the backend is a normal version rollback of the Go images, not a parallel Node stack. Shared code lives in `packages/` (`db` for Prisma schema + seeds, `config` for lint/tsconfig presets, `utils` for Zod loaders/loggers, `mongo` for Mongoose helpers). Operational assets sit in `infra/` (Docker compose files plus helper scripts). Place new modules beside the feature they serve; extract to `packages/utils` only when the logic is reused by multiple apps.

## Build, Test, and Development Commands

`pnpm dev` launches the repository chain in watch mode: `apps/api-go` (Go gateway, :4020), `apps/vector-go`, and `apps/web`; `pnpm dev:ais-relay` runs only the Go AIS relay. `pnpm build`, `pnpm lint`, and `pnpm typecheck` fan out through Turbo to every package. Schema changes must run `pnpm db:migrate` and `pnpm db:seed` — Prisma and the Mongo index script remain Node tooling on purpose and are not part of the Go binaries. Local stacks are controlled with `pnpm docker:up`, `pnpm docker:logs`, and `pnpm docker:down`; copy env samples before invoking them. The default (and only) compose stack runs `api-go`, `vector-go`, and `ais-relay-go` plus the one-shot `migrate`/`mongo-indexes` tool services and `web`; there is no `legacy-node` profile or rollback override.

`pnpm dev` / `pnpm dev:ais-relay` run through `infra/scripts/src/dev.mts`. It loads the repository-root `.env` with dotenv (already-exported process variables win), applies the local API/Socket.IO/address values and a per-service `PORT`, then forwards SIGINT/SIGTERM to each child process group. It never runs migrations, seeds, Docker or network probes. Plain Go processes do not read the root `.env` themselves, so direct `go run` / package `dev` invocations must receive their environment from the caller. These commands do not pass through Turbo; a manual `turbo run dev` needs `--env-mode=loose` to receive resource variables.

## Feature Delivery Expectations

- End-to-end changes: when you implement or change a backend feature in `apps/api-go`, also update the corresponding UI in `apps/web` so the feature is usable from the console (API + UI + shared types). Only skip UI work when the user explicitly requests a backend-only change.
- Git: after a fix or feature is complete and verified (lint/typecheck + pure static code review pass), automatically commit and push to the cloud with a Chinese commit message following the repo's emoji + `type(scope)` style (e.g. `🔐 fix(security): ...`). Only stage files you changed; never commit unrelated worktree noise, secrets, or `.env` files. Do not amend, rebase, or force-push.
- Worktree noise: assume unrelated modified/untracked files are expected (the user often runs multiple Codex CLI sessions in parallel). Do not call them out or ask about them unless they directly block the requested work (e.g., merge conflicts in touched files).

## Coding Style & Naming Conventions

TypeScript strict mode is on; exported symbols need explicit types and enums should beat string unions for shared protocols. Follow ESLint + Prettier defaults (2-space indent, single quotes, semicolons) and let lint-staged auto-fix staged files. React components and Nest providers use PascalCase, hooks/middleware stay camelCase, and `.env` keys remain SCREAMING_SNAKE_CASE. Keep folder names aligned with bounded contexts such as `auth`, `rbac`, or `projects`.

## Code Review & Verification

Verification is `pnpm lint`, `pnpm typecheck`, `pnpm --filter @modular/web test -- --coverage`, the Go unit tests (`pnpm --filter @modular/api-go --filter @modular/vector-go test`), plus read-only static review of touched paths. GitHub Actions CI (`.github/workflows/ci.yml`) is the merge gate.

- `apps/web` uses Vitest + Testing Library + jsdom for **component/behavior** tests (`*.test.ts` / `*.test.tsx`). Prefer user-visible assertions (render, events, API mocks). Do not add source-text or snapshot-of-implementation tests. Coverage collection and thresholds are part of the merge gate.
- `apps/api-go` uses Go tests for config defaults, route ownership, handler contracts and business-constraint coverage (SEC-01 vector-service platform-admin boundary, API-01 onboarding `items.read`, orgId-scoped authz). The Go gateway no longer reads any `API_GO_*_MODE` switch: each unit is always on, and the retained execution gates are `SCHEDULE_ENABLED` / `BULLMQ_WORKERS_ENABLED` / `WS_REDIS_ADAPTER_ENABLED` / `GRAPHQL_SUBSCRIPTION_BUS`. The committed OpenAPI/auth-matrix artifacts are historical expectations reconciled against the real Go route table by `internal/legacyproxy/contract_registration_test.go`.
- `apps/vector-go` keeps its Go unit tests and a real-Qdrant contract integration test (`-tags=integration`, `/healthz`, `/v1/upsert`, `/v1/search`, internal token, orgId filtering). Do not restore API Jest / Nest testing / e2e suites unless explicitly requested. Do not add `*.spec.ts`, `*.e2e-spec.ts`, or test-only API dependencies (jest, ts-jest, supertest, `@nestjs/testing`).
- For every change, statically review types/interfaces and GraphQL schema contracts, control flow and error handling, and `orgId`-scoped authorization on cross-tenant operations. Confirm each finding with `file:line` evidence (adversarial re-verification, mirroring `.workflow/reviews/static-audit.md`).

## Environment & Ops Tips

Configure secrets by copying `.env.example` to `.env` and `infra/docker/.env.sample` to `infra/docker/.env`, then running `pnpm --filter infra-scripts run env:check`. Docker Compose publishes ports on `127.0.0.1` by default (`DOCKER_PUBLISH_HOST`); the LiteLLM proxy refuses to start without `LITELLM_MASTER_KEY`. `NEXTAUTH_SECRET` is runtime-only—never pass it as a Docker build ARG. Avoid committing local overrides; use Docker Compose profiles or `.env.local`. When adding services, extend `infra/docker/docker-compose.yml` and note exposed ports in README and this guide.

`apps/vector-go` fails closed in production: `VECTOR_INTERNAL_TOKEN` is required and must not be `dev-token`, and `QDRANT_API_KEY` is required. The compose file marks both as mandatory, so a default stack refuses to start without them instead of silently serving with a placeholder token.

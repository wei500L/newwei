# Repository Guidelines

## Backend Migration Navigation

进行后端迁移规划或相关进度更新前，先读取 [迁移地图入口](docs/refactor/migration-map/README.md) 和 [规划规则](docs/refactor/migration-map/PLANNING.md)。

## Project Structure & Module Organization

This pnpm + Turborepo workspace splits runtime apps under `apps/`: `apps/api-go` is the default backend gateway (Go, REST + GraphQL + WebSocket), `apps/vector-go` the default vector service, and `apps/web` powers the Next.js console. `apps/api` (NestJS), `apps/vector`, and `apps/ais-relay` are kept as the explicit legacy rollback and are no longer started by default. Shared code lives in `packages/` (`db` for Prisma schema + seeds, `config` for lint/tsconfig presets, `utils` for Zod loaders/loggers, `mongo` for Mongoose helpers). Operational assets sit in `infra/` (Docker compose files plus helper scripts). Place new modules beside the feature they serve; extract to `packages/utils` only when the logic is reused by multiple apps.

## Build, Test, and Development Commands

`pnpm dev` launches the repository default chain in watch mode: `apps/api-go` (Go gateway, :4020), `apps/vector-go`, and `apps/web`. `pnpm dev:legacy` instead launches the NestJS `apps/api`, Node `apps/vector`, `apps/ais-relay`, and `apps/web`, and is the supported rollback for local development. `pnpm build`, `pnpm lint`, and `pnpm typecheck` fan out through Turbo to every package. Schema changes must run `pnpm db:migrate` and `pnpm db:seed` — Prisma and the Mongo index script remain Node tooling on purpose and are not part of the Go binaries. Local stacks are controlled with `pnpm docker:up`, `pnpm docker:logs`, and `pnpm docker:down`; copy env samples before invoking them. The default compose stack runs `api-go`, `vector-go`, and `ais-relay-go`, with the Node backends behind the `legacy-node` profile; `infra/docker/legacy-rollback.override.yml` plus `infra/docker/legacy-rollback.env.sample` restores them together.

## Feature Delivery Expectations

- End-to-end changes: when you implement or change a backend feature in `apps/api`, also update the corresponding UI in `apps/web` so the feature is usable from the console (API + UI + shared types). Only skip UI work when the user explicitly requests a backend-only change.
- Git: after a fix or feature is complete and verified (lint/typecheck + pure static code review pass), automatically commit and push to the cloud with a Chinese commit message following the repo's emoji + `type(scope)` style (e.g. `🔐 fix(security): ...`). Only stage files you changed; never commit unrelated worktree noise, secrets, or `.env` files. Do not amend, rebase, or force-push.
- Worktree noise: assume unrelated modified/untracked files are expected (the user often runs multiple Codex CLI sessions in parallel). Do not call them out or ask about them unless they directly block the requested work (e.g., merge conflicts in touched files).

## Coding Style & Naming Conventions

TypeScript strict mode is on; exported symbols need explicit types and enums should beat string unions for shared protocols. Follow ESLint + Prettier defaults (2-space indent, single quotes, semicolons) and let lint-staged auto-fix staged files. React components and Nest providers use PascalCase, hooks/middleware stay camelCase, and `.env` keys remain SCREAMING_SNAKE_CASE. Keep folder names aligned with bounded contexts such as `auth`, `rbac`, or `projects`.

## Code Review & Verification

Verification is `pnpm lint`, `pnpm typecheck`, `pnpm --filter @modular/web test -- --coverage`, `pnpm --filter @modular/vector test`, plus read-only static review of touched paths. GitHub Actions CI (`.github/workflows/ci.yml`) is the merge gate.

- `apps/web` uses Vitest + Testing Library + jsdom for **component/behavior** tests (`*.test.ts` / `*.test.tsx`). Prefer user-visible assertions (render, events, API mocks). Do not add source-text or snapshot-of-implementation tests. Coverage collection and thresholds are part of the merge gate.
- `apps/api-go` uses Go tests for config defaults, route ownership and handler contracts. `apps/api-go/internal/config` additionally holds cutover gates: the default configuration must resolve to all-go with `API_GO_LEGACY_FALLBACK_MODE=reject` from resources alone (`testdata/default-resources.env` sets no switch), and fixtures that name switches explicitly must stay complete.
- `apps/vector` and `apps/vector-go` keep their Vitest / Go unit tests for internal-auth and orgId-filtered retrieval. Do not restore API Jest / Nest testing / e2e suites unless explicitly requested. Do not add `*.spec.ts`, `*.e2e-spec.ts`, or test-only API dependencies (jest, ts-jest, supertest, `@nestjs/testing`).
- For every change, statically review types/interfaces and GraphQL schema contracts, control flow and error handling, and `orgId`-scoped authorization on cross-tenant operations. Confirm each finding with `file:line` evidence (adversarial re-verification, mirroring `.workflow/reviews/static-audit.md`).

## Environment & Ops Tips

Configure secrets by copying `.env.example` to `.env` and `infra/docker/.env.sample` to `infra/docker/.env`, then running `pnpm --filter infra-scripts run env:check`. Docker Compose publishes ports on `127.0.0.1` by default (`DOCKER_PUBLISH_HOST`); the LiteLLM proxy refuses to start without `LITELLM_MASTER_KEY`. `NEXTAUTH_SECRET` is runtime-only—never pass it as a Docker build ARG. Avoid committing local overrides; use Docker Compose profiles or `.env.local`. When adding services, extend `infra/docker/docker-compose.yml` and note exposed ports in README and this guide.

`apps/vector-go` fails closed in production: `VECTOR_INTERNAL_TOKEN` is required and must not be `dev-token`, and `QDRANT_API_KEY` is required. The compose file marks both as mandatory, so a default stack refuses to start without them instead of silently serving with a placeholder token.

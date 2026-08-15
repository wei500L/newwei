# Repository Guidelines

## Project Structure & Module Organization

This pnpm + Turborepo workspace splits runtime apps under `apps/`: `apps/api` exposes the NestJS GraphQL/REST gateway, and `apps/web` powers the Next.js console. Shared code lives in `packages/` (`db` for Prisma schema + seeds, `config` for lint/tsconfig presets, `utils` for Zod loaders/loggers, `mongo` for Mongoose helpers). Operational assets sit in `infra/` (Docker compose files plus helper scripts). Place new modules beside the feature they serve; extract to `packages/utils` only when the logic is reused by multiple apps.

## Build, Test, and Development Commands

`pnpm dev` launches API + Web in watch mode, while `pnpm build`, `pnpm lint`, and `pnpm typecheck` fan out through Turbo to every package. Schema changes must run `pnpm db:migrate` and `pnpm db:seed`. Local stacks are controlled with `pnpm docker:up`, `pnpm docker:logs`, and `pnpm docker:down`; copy env samples before invoking them.

## Feature Delivery Expectations

- End-to-end changes: when you implement or change a backend feature in `apps/api`, also update the corresponding UI in `apps/web` so the feature is usable from the console (API + UI + shared types). Only skip UI work when the user explicitly requests a backend-only change.
- Git: after a fix or feature is complete and verified (lint/typecheck + pure static code review pass), automatically commit and push to the cloud with a Chinese commit message following the repo's emoji + `type(scope)` style (e.g. `🔐 fix(security): ...`). Only stage files you changed; never commit unrelated worktree noise, secrets, or `.env` files. Do not amend, rebase, or force-push.
- Worktree noise: assume unrelated modified/untracked files are expected (the user often runs multiple Codex CLI sessions in parallel). Do not call them out or ask about them unless they directly block the requested work (e.g., merge conflicts in touched files).

## Coding Style & Naming Conventions

TypeScript strict mode is on; exported symbols need explicit types and enums should beat string unions for shared protocols. Follow ESLint + Prettier defaults (2-space indent, single quotes, semicolons) and let lint-staged auto-fix staged files. React components and Nest providers use PascalCase, hooks/middleware stay camelCase, and `.env` keys remain SCREAMING_SNAKE_CASE. Keep folder names aligned with bounded contexts such as `auth`, `rbac`, or `projects`.

## Code Review & Verification (Static Only)

This repository has no unit/E2E test suites — all `*.spec.ts`/`*.test.ts` files and test toolchains (Jest, Vitest, `tsx --test`) have been removed. Agent tools must verify changes through **pure static code review**, never by writing, running, or relying on test suites:

- Do not create test files (`*.spec.ts`, `*.test.ts`, `*.e2e-spec.ts`) or test directories (`__tests__/`, `tests/`, `test/`); do not add test-only dependencies (jest, vitest, ts-jest, supertest, @nestjs/testing, etc.).
- Verification is limited to `pnpm lint` and `pnpm typecheck`; there is no `pnpm test` command.
- For every change, conduct a read-only static review of the touched code paths before committing: check types/interfaces and GraphQL schema contracts, trace control flow and error handling, verify `orgId`-scoped authorization on cross-tenant operations, and confirm each finding with `file:line` evidence (adversarial re-verification of claims against the actual code, mirroring the `.workflow/reviews/static-audit.md` workflow).

## Environment & Ops Tips

Configure secrets by copying `.env.example` to `.env` and `infra/docker/.env.sample` to `infra/docker/.env`, then running `pnpm --filter infra-scripts run env:check`. Docker Compose publishes ports on `127.0.0.1` by default (`DOCKER_PUBLISH_HOST`); the LiteLLM proxy refuses to start without `LITELLM_MASTER_KEY`. `NEXTAUTH_SECRET` is runtime-only—never pass it as a Docker build ARG. Avoid committing local overrides; use Docker Compose profiles or `.env.local`. When adding services, extend `infra/docker/docker-compose.yml` and note exposed ports in README and this guide.

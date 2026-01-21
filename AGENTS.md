# Repository Guidelines

## Project Structure & Module Organization
This pnpm + Turborepo workspace splits runtime apps under `apps/`: `apps/api` exposes the NestJS GraphQL/REST gateway, and `apps/web` powers the Next.js console. Shared code lives in `packages/` (`db` for Prisma schema + seeds, `config` for lint/tsconfig presets, `utils` for Zod loaders/loggers, `mongo` for Mongoose helpers). Operational assets sit in `infra/` (Docker compose files plus helper scripts). Place new modules beside the feature they serve; extract to `packages/utils` only when the logic is reused by multiple apps.

## Build, Test, and Development Commands
`pnpm dev` launches API + Web in watch mode, while `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` fan out through Turbo to every package. Schema changes must run `pnpm db:migrate` and `pnpm db:seed`. Local stacks are controlled with `pnpm docker:up`, `pnpm docker:logs`, and `pnpm docker:down`; copy env samples before invoking them.

## Feature Delivery Expectations
- End-to-end changes: when you implement or change a backend feature in `apps/api`, also update the corresponding UI in `apps/web` so the feature is usable from the console (API + UI + shared types). Only skip UI work when the user explicitly requests a backend-only change.
- Git: do not create, edit, or manage commits (including commit messages, staging, rebases, or history edits) unless the user explicitly asks.

## Coding Style & Naming Conventions
TypeScript strict mode is on; exported symbols need explicit types and enums should beat string unions for shared protocols. Follow ESLint + Prettier defaults (2-space indent, single quotes, semicolons) and let lint-staged auto-fix staged files. React components and Nest providers use PascalCase, hooks/middleware stay camelCase, and `.env` keys remain SCREAMING_SNAKE_CASE. Keep folder names aligned with bounded contexts such as `auth`, `rbac`, or `projects`.

## Testing Guidelines
Backend suites use Jest: `pnpm --filter @modular/api test` covers units, and `pnpm --filter @modular/api test:e2e` validates `/api/healthz` plus login flows. Front-end work should add Vitest or Playwright specs under `apps/web/tests` until the planned suites are merged. Name files `{feature}.spec.ts` for units and `{feature}.e2e-spec.ts` for end-to-end cases, and stash builders in `__fixtures__`. Touching guards, RBAC policies, or Prisma models should bump coverage and include at least one regression test.

## Environment & Ops Tips
Configure secrets by copying `.env.example` to `.env` and `infra/docker/.env.sample` to `infra/docker/.env`, then running `pnpm --filter infra-scripts run env:check`. Avoid committing local overrides; use Docker Compose profiles or `.env.local`. When adding services, extend `infra/docker/docker-compose.yml` and note exposed ports in README and this guide.

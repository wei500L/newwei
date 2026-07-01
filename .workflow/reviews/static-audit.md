# Static Audit Report

> Pure static review — no execution, no services, no installs, no tests/build/lint/typecheck, no network, no source mutation.
> Method: 7-agent workflow (A scout · B security · C queue/consistency · D contract · E fe-auth/realtime · F fe-state · G verify). Each raw finding was adversarially re-verified against the cited code by an independent skeptic before inclusion.
> Result: 16 raw findings → 12 **confirmed**, 1 **uncertain**, 3 **rejected**. Severity ceiling is P2 (no P0/P1 confirmed).

---

## Executive Summary

**Overall risk: multi-tenant isolation is the dominant, HIGH risk.** Tenant isolation in this codebase is *manual* — there is no Prisma middleware / RLS; every service must thread `orgId` into every query and every client-side layer must reset on org switch. That single systemic property is where every top finding lives.

Three confirmed **P2** defects break the tenant boundary with no exotic preconditions:

- **B-2** — any org admin can rename, re-slug, or fully **disable a *different* tenant** (`setOrgActive(false)` = complete login DoS of the victim org), because the `org.write` check is evaluated against the *caller's active org*, not the org being mutated.
- **B-1** — any authenticated user with `alerts.manage` in their own org can **force-evaluate another tenant's alert rules** (spurious `AlertEvent`s, real notification/email/webhook delivery, cooldown tampering), because `triggerAlertRule` loads the rule by id with **no `orgId` predicate**.
- **F-1** — after switching organizations the app **serves the previous org's GraphQL data** because the Apollo `InMemoryCache` singleton is never invalidated and the default policy is `cache-first`.

These are compounded by two auth-surface **P2**s — a post-auth **open redirect** (E-1) and **inconsistent expired-session handling** (E-2) — plus a shared client-org-scope-leak theme (F-2 NewsNow prefs, F-3 war-map deep link). The remaining P3s (C-3, C-4, C-5, D-1) are pipeline durability / realtime-delivery / contract reliability issues that degrade correctness but do not by themselves cross tenants.

**Fix strategy (cheap + high-impact first):** land E-1, B-2, B-1 (all localized authorization/redirect fixes) → then client cache/session resets F-1, E-2, D-1, F-2, F-3 → then the higher-cost scheduler/durability/realtime work C-2, C-5, C-3, C-4.

### Top 5 to fix first

| # | ID | Severity | One-line |
|---|----|----------|----------|
| 1 | **B-2** | P2 | Any org admin can rename/re-slug or **disable** a different tenant; write check binds to caller's active org, not the target org. |
| 2 | **B-1** | P2 | `triggerAlertRule` loads the rule by id with no `orgId` scope → cross-tenant forced evaluation, real notifications, cooldown tampering. |
| 3 | **F-1** | P2 | Apollo `InMemoryCache` singleton never cleared on org switch → `cache-first` returns previous org's data until hard reload. |
| 4 | **E-1** | P2 | `callbackUrl` pushed to router after login without same-origin validation → post-auth open redirect (phishing). |
| 5 | **E-2** | P2 | Protected routes missing from middleware matcher SSR-render with an empty token on `RefreshAccessTokenError` → broken 401 pages + forced sign-out. |

### Risk distribution (12 confirmed, by area / by severity)

| Area | Count | | Severity | Count |
|------|:-----:|---|----------|:-----:|
| frontend | 3 (E-2, F-2, F-3) | | P0 | 0 |
| security | 2 (B-2, E-1) | | P1 | 0 |
| queue | 2 (C-2, C-5) | | **P2** | **7** (B-1, B-2, C-2, E-1, E-2, F-1, F-3) |
| data | 2 (C-3, F-1) | | **P3** | **5** (C-3, C-4, C-5, D-1, F-2) |
| backend | 1 (B-1) | | | |
| realtime | 1 (C-4) | | | |
| contract | 1 (D-1) | | | |

### Architecture & trust boundaries (scout context)

- **Two parallel auth stacks.** REST/HTTP is protected by two global `APP_GUARD`s in `AppModule` (`apps/api/src/app.module.ts:110-124`): `JwtAuthGuard` + `PermissionsGuard`. **Both deliberately `return true` for GraphQL context** (`jwt-auth.guard.ts:14`, `permissions.guard.ts:15`) — GraphQL is instead guarded by a *second* `APP_GUARD` trio inside `ApiGraphqlModule` (`graphql.module.ts:327-338`): `GqlAuthGuard → GqlPermissionsGuard → GraphqlRateLimitGuard`. WebSocket gateways do **hand-rolled auth** in `handleConnection` (no guard). Three boundaries must be kept in sync.
- **Token trust model is sound at the query layer:** JWT `permissions[]` are *not* trusted — `JwtStrategy.validate` re-derives the profile via `getUserProfile(sub, orgId)`, recomputing permissions from DB memberships and honoring `orgId` only if a matching membership exists.
- **The gap is authorization *scoping*, not authentication.** Permissions are bound to the caller's *active* org; when a mutation accepts a client-supplied target `id` (org, alert rule, …), nothing re-binds the permission to that target's org. B-1 and B-2 are the two confirmed instances of exactly this class.
- **Client-side org scoping is inconsistent.** `situation-monitor`/`war-map` Zustand stores *are* reset on `orgId` change (proving the intended pattern), but the Apollo cache (F-1) and NewsNow store (F-2) are not.
- **Dual-store consistency (MySQL/Prisma + Mongo) is reconciled by best-effort/in-memory outbox mechanisms** — the source of C-3 (permanent orphan after `dead` outbox) and the realtime drop in C-4.

---

## Confirmed Issues

### [P2] E-1 — Open redirect after login: `callbackUrl` navigated without same-origin validation

- **Area:** security (frontend)
- **Files:**
  - `apps/web/app/(auth)/login/page.tsx:118`
  - `apps/web/app/(auth)/login/page.tsx:119`
  - `apps/web/app/(auth)/login/page.tsx:120`
  - `apps/web/app/(auth)/login/page.tsx:157`
  - `apps/web/app/(auth)/login/page.tsx:199`
- **Static Evidence:** `redirectAfterLogin()` reads the raw query param and navigates to it with no validation: `const redirectTo = searchParams.get("callbackUrl") ?? "/dashboard"; router.push(redirectTo);` (lines 119-120). It is invoked after a successful `signIn` in `onPasswordLogin` (157) and `onCodeLogin` (199). Because `signIn` is called with `redirect: false` (143, 186), NextAuth's own `callbackUrl` sanitization is bypassed, and `next/navigation` `router.push()` with a fully-qualified external URL performs a hard cross-origin navigation. A repo-wide grep found no `isSafeRedirect`/sanitize helper in `apps/web`.
- **Trigger Path:** Attacker sends victim `/login?callbackUrl=https://evil.example/phish`. Victim authenticates normally; on success `redirectAfterLogin()` runs `router.push("https://evil.example/phish")` and the freshly-authenticated user is navigated off-site.
- **Impact:** Post-authentication open redirect (CWE-601) enabling credible phishing / OAuth-style token-theft flows; the redirect happens for an already-logged-in user, increasing trust in the destination.
- **Why this is not a false positive:** The value comes directly from `searchParams` with only a `?? "/dashboard"` null-fallback; there is no relative/same-origin check. NextAuth's protection is out of play because `redirect:false` + manual `router.push` is used. Both login flows confirmed to call it.
- **Suggested Fix:** Accept `redirectTo` only if it starts with `/` and not `//`, or parse `new URL(redirectTo, location.origin)` and require the resolved origin `=== location.origin`; otherwise fall back to `/dashboard`.
- **Regression Test Idea:** Unit-test a sanitize helper with `'/dashboard'` (allow), `'//evil.com'` (reject), `'https://evil.com'` (reject), `'javascript:alert(1)'` (reject).

---

### [P2] B-2 — Broken access control: `updateOrg` / `setOrgActive` check `org.write` against the caller's active org, not the target org

- **Area:** security
- **Files:**
  - `apps/api/src/graphql/resolvers/org.resolver.ts:40`
  - `apps/api/src/graphql/resolvers/org.resolver.ts:50`
  - `apps/api/src/modules/org/org.service.ts:219`
  - `apps/api/src/modules/org/org.service.ts:302`
  - `apps/api/src/modules/org/org.service.ts:337`
- **Static Evidence:** `updateOrg` (40-48) and `setOrgActive` (50-61) are gated by `@HasPermission("org.write")`. `GqlPermissionsGuard` evaluates `user.permissions`, which are derived from the caller's **active** org (`getUserProfile(sub, payload.orgId) → pickMembership → buildMembershipClaims → collectMembershipPermissionSet` on a *single* active-org membership). The mutation then passes a client-supplied `input.id` (arbitrary org) to the service. `org.service.ts` `updateOrg` (225) and `setOrgActive` (304) call `assertActorMembership(actorId, orgId)`, which (337-357) only does `membership.findUnique({ where:{ userId_orgId:{ userId: actorId, orgId } } })` and throws only if **no** membership exists — it never checks the actor's role/permission in that target org. Then `prisma.org.update({ where:{ id: orgId }, data })` runs. `packages/config/src/rbac.ts` confirms `org.write` is granted only to the system `admin` role (not `manager`/`analyst`).
- **Trigger Path:** A user who is admin (`org.write`) in Org A and *also* a plain member (analyst/viewer) of Org B logs in with Org A active, then calls `updateOrg(input:{id:<OrgB>, slug:"hijacked"})` or `setOrgActive(input:{id:<OrgB>, isActive:false})`. Permission guard passes (org.write from Org A), `assertActorMembership` passes (member of Org B), and Org B is mutated.
- **Impact:** Horizontal cross-tenant privilege escalation: rename Org B, change its slug (breaking slug-based login / slug-squatting), or **disable Org B entirely** via `setOrgActive(false)` — after which `assertMembershipAccessible` throws "Organization disabled" for every Org B user on login/refresh (full victim-tenant DoS). None require `org.write`/admin in the victim org.
- **Why this is not a false positive:** `assertActorMembership` was read in full — it checks membership *existence* only. The authorizing permission is bound to the caller's active-org claims, not to `input.id`. No global guard/pipe/Prisma middleware re-scopes `input.id`. `rbac.ts` confirms `org.write` ⇒ admin-only, so the missing target-org check is the only thing separating a mere member from an org admin.
- **Suggested Fix:** In `updateOrg`/`setOrgActive`, re-derive the actor's role/permissions within the **target** org (`input.id`) and require `org.write`/system-admin there — mirror `UserAdminService.assertActorIsOrgAdmin(orgId, actorId)` — instead of `assertActorMembership` + active-org claims.
- **Regression Test Idea:** User is admin in Org A and analyst (no `org.write`) in Org B; call `setOrgActive({id:OrgB, isActive:false})` and `updateOrg({id:OrgB,...})`; assert `ForbiddenException` and Org B unchanged.

---

### [P2] B-1 — Cross-tenant IDOR: `triggerAlertRule` force-evaluates any org's alert rule by id (no `orgId` scoping)

- **Area:** backend (security)
- **Files:**
  - `apps/api/src/graphql/resolvers/alerts.resolver.ts:246`
  - `apps/api/src/graphql/resolvers/alerts.resolver.ts:248`
  - `apps/api/src/modules/alerts/alerts.service.ts:1123`
  - `apps/api/src/modules/alerts/alerts.processor.ts:38`
  - `apps/api/src/modules/alerts/alerts.service.ts:1169`
  - `apps/api/src/modules/alerts/alerts.service.ts:459`
- **Static Evidence:** In `alerts.resolver.ts` every mutation passes `requester.orgId` **except** `triggerAlertRule` (246-251), which takes only `@Args("ruleId")`, no `@Context("req")`, no requester, no org filter, and calls `this.alerts.enqueueRuleCheck(ruleId)`. `enqueueRuleCheck(ruleId, orgId?)` (1123) enqueues `{type:"evaluate", ruleId, orgId}` with `orgId=undefined`. `alerts.processor.ts:38-39` runs `evaluateRule(job.data.ruleId)` and never uses the payload `orgId` for scoping. `evaluateRule` (1169-1173) resolves the rule via `prisma.alertRule.findUnique({ where:{ id: ruleId } })` — **no `orgId` predicate** — then creates an `AlertEvent` (1217), updates `rule.lastTriggeredAt` (1230), and delivers to `rule.orgId`'s channels/members (1235-1258). Default rule ids are attacker-derivable: `buildDefaultRealtimeSignalRuleId` (459) ⇒ `default-realtime-signal-${key}-${orgId}` and `buildDefaultCrawlQualityRuleId` (448) ⇒ `default-crawl-quality-${key}-${orgId}`. `@HasPermission` is pure RBAC metadata; it authorizes the caller's permission but does not scope the `ruleId` argument.
- **Trigger Path:** Authenticated user with `alerts.manage` in Org A sends `triggerAlertRule(ruleId:"default-realtime-signal-opensky-<OrgB-id>")`. Org B's id is disclosed by the login/refresh `organizations` list and `myOrganizations`; built-in rule ids are deterministic from it. The evaluate job runs against Org B's rule with no tenant check.
- **Impact:** Cross-tenant broken access control: force out-of-schedule evaluation of another org's alert rules → spurious `AlertEvent`s for Org B, real notifications/emails/webhooks to Org B's channels/members, tampering with Org B's `lastTriggeredAt`/cooldown state, notification spam.
- **Why this is not a false positive:** Every sibling mutation in the same resolver (`deleteRule`, `updateEventStatus`, `getEventReplay`, `upsertRule`) passes `requester.orgId` and the service verifies `existing.orgId !== orgId`. `triggerAlertRule` is the sole method passing only a client-supplied id, and `evaluateRule`'s `findUnique` has no `orgId` filter (lines read directly). *Verifier nuance:* two secondary claims are overstated — the boolean response is not a reliable existence oracle (always returns `true`), and `evaluateRule` still requires `shouldTrigger` + cooldown, so arbitrary event fabrication is bounded → **P2, not higher**.
- **Suggested Fix:** Make `triggerAlertRule` accept `@Context("req")`, require the user, and enqueue via an org-scoped path that first verifies `findFirst({ where:{ id: ruleId, orgId } })`; have `evaluateRule`/`enqueueRuleCheck` require and filter by `orgId`.
- **Regression Test Idea:** User in Org A with `alerts.manage` calls `triggerAlertRule` with a `ruleId` owned by Org B; assert it throws NotFound/Forbidden and that no `AlertEvent`/`AlertDelivery` is created for the Org B rule.

---

### [P2] F-1 — Apollo `InMemoryCache` singleton not invalidated on org switch → `cache-first` serves the previous org's data

- **Area:** data (frontend)
- **Files:**
  - `apps/web/lib/apollo-client.ts:42`
  - `apps/web/lib/apollo-client.ts:197`
  - `apps/web/lib/apollo-client.ts:206`
  - `apps/web/app/(app)/components/organization-switcher.tsx:101`
  - `apps/web/app/providers.tsx:151`
  - `apps/web/hooks/useEconomicData.ts:277`
- **Static Evidence:** `apollo-client.ts:197-203` sets `defaultOptions.watchQuery.fetchPolicy:"cache-first"` on a module-level singleton `let apolloClient` (42) returned by `getApolloClient()` (211: `if (!apolloClient) apolloClient = createApolloClient()`). `organization-switcher.tsx` `handleSwitch` (101-114) only POSTs `/api/organizations/switch`, calls `update(sessionPatch)` and `setBrowserAuthSession(...)` — **no page reload, no `resetStore()`/`clearStore()`** (repo-wide grep for `resetStore|clearStore|cache.evict|gc` → 0 Apollo hits). `providers.tsx:151` binds the client once via `useState(getApolloClient)`. `useEconomicData.ts:277-288` calls the query with variables `{category,start,end}` and no `fetchPolicy` override → inherits `cache-first`; Apollo keys by query+variables+`__typename`/id, with **no `orgId` dimension**.
- **Trigger Path:** Multi-org user opens `/dashboard/economic-short` (or any Apollo chart) under Org A → data cached. Uses the top-nav `OrganizationSwitcher` to switch to Org B. Navigates back to the same chart with the same category/time range → the identical operation resolves `cache-first`.
- **Impact:** The user, now scoped to Org B, is shown Org A's cached points/insights/entities until a hard reload — wrong-org staleness and potential cross-tenant data exposure; colliding entity ids can surface the wrong org's normalized cache entry.
- **Why this is not a false positive:** The cache is a documented singleton (`42`/`211`), default policy is `cache-first` (`199`), the switch handler performs no invalidation, and no `resetStore`/`clearStore` exists anywhere in the codebase. `user-ui-settings-sync.tsx:527-529` *does* reset Zustand stores on `orgId` change — proving org-scoped resets are the intended pattern that the Apollo layer lacks. *Verifier nuance:* downgraded P1→**P2** because the user is authorized for both orgs (correctness/staleness, not unauthorized cross-account access) and it self-heals on hard reload.
- **Suggested Fix:** In the org-switch success path call `await getApolloClient().resetStore()` (and `queryClient.clear()`), or rebuild/key the Apollo client on `session.orgId` change in a small effect in providers/shell.
- **Regression Test Idea:** Mock two orgs; run an economic query under Org A, switch org, assert the same query issues a network fetch (not a cache hit) and returns Org B data.

---

### [P2] E-2 — Errored (`RefreshAccessTokenError`) session not redirected on protected routes missing from the middleware matcher

- **Area:** frontend
- **Files:**
  - `apps/web/middleware.ts:4`
  - `apps/web/app/(app)/layout.tsx:10`
  - `apps/web/lib/auth.ts:317`
  - `apps/web/lib/auth.ts:357`
- **Static Evidence:** `middleware.ts` matcher (4-17) lists dashboard/items/today/topics/map/finance/alerts/search/subscriptions/admin/settings/profile but **omits** `/events`, `/crawl`, `/assistant`, `/events-archive`, `/rss` (all confirmed real `(app)` routes). The middleware is the only place the `authorized` callback runs, and that callback is what blocks errored sessions: `auth.ts:319` `return !!session && session.error !== "RefreshAccessTokenError"`. The server guards for the omitted routes only check truthiness — `(app)/layout.tsx:11` `if (!session) redirect("/login")` and `events/page.tsx:91` do the same. When refresh fails the jwt callback still returns a **truthy** token with `error` set and `accessToken:""` (`auth.ts:357-364`), so `!session` is false and the guard passes.
- **Trigger Path:** A user whose refresh token expired/was revoked reloads `/assistant` (or `/events`, `/crawl`) directly. On a matcher route (`/dashboard`) the middleware `authorized` callback redirects to `/login`; on `/assistant` it does not, so the page SSR-renders with an empty `accessToken`.
- **Impact:** Inconsistent auth: some routes give a clean login redirect, others SSR-render with an empty token so every `fetchGraphql` 401s and returns null (`server-graphql.ts:43-49`), yielding a broken/empty page until the client `SessionErrorListener` mounts and forcibly signs out — double-handling and confusing UX for the same expired-session condition.
- **Why this is not a false positive:** The route-list-vs-matcher mismatch is directly readable, and `auth.ts:357-364` proves the errored token is truthy with an empty `accessToken`, so `if (!session)` cannot catch it; only the middleware-only `authorized` callback filters it, and those routes are unmatched.
- **Suggested Fix:** Add the missing paths to the middleware matcher, or have the shared `(app)` layout/pages also redirect when `session.error === "RefreshAccessTokenError"`, not just when `!session`.
- **Regression Test Idea:** With a session containing `error:'RefreshAccessTokenError'`, assert the `(app)` layout redirects to `/login` for `/events` and `/assistant` the same way it does for `/dashboard`.

---

### [P2] F-3 — War-map shareable URL loses view/preset/layers: remote-settings hydrate overwrites URL-derived state (only `aisMode` preserved)

- **Area:** frontend
- **Files:**
  - `apps/web/app/(app)/dashboard/charts/war-map/url-state.ts:127`
  - `apps/web/app/(app)/dashboard/charts/war-map/url-state.ts:143`
  - `apps/web/store/war-map-settings.ts:212`
  - `apps/web/app/(app)/components/user-ui-settings-sync.tsx:725`
  - `apps/web/app/(app)/dashboard/charts/war-map/war-map.tsx:1001`
- **Static Evidence:** `writeWarMapUrlState` (`url-state.ts:143-189`) serializes lat/lon/zoom/bearing/pitch, `preset`, `tr`, `fm`, `am` and `layers` to the URL, and the war-map seed effect (`war-map.tsx:1006-1026`) reads them all back. But `mergeWarMapSettingsWithUrlState` (`url-state.ts:127-141`) returns `normalizeWarMapSettings(payload)` and only overrides `aisMode` from the URL (`if (!parsed.aisMode) return normalized; return {...normalized, aisMode: parsed.aisMode}`) — viewState/activePreset/timeRangePreset/layerVisibility/flightMode from the URL are dropped. `hydrateFromRemote` (`war-map-settings.ts:212-222`) fully **replaces** the store. `UserUiSettingsSync` (mounted app-shell-globally, `shell.tsx:174`) `resetAll()`s then, after an `await`ed GET `user-settings/ui/war-map`, calls `hydrateFromRemote(mergeWarMapSettingsWithUrlState(data.settings, window.location.search))` (725-733) — which necessarily runs *after* the synchronous seed effect (which has set `hasHydratedUrlRef=true`). The merge function's own unit test (`apps/web/tests/war-map-url-state.spec.ts:143-158`) asserts only `aisMode` is taken from the URL, codifying the asymmetry.
- **Trigger Path:** A logged-in user who has previously saved war-map settings opens a shared/bookmarked deep link `/map?preset=america&zoom=5&layers=flights,ais`. The seed effect applies all params; then the shell's async GET resolves and `hydrateFromRemote(merge(remote, url))` runs.
- **Impact:** ~one network round-trip later the store is fully replaced with server preset/view/layers (keeping only `aisMode`); the map jumps away from the shared view, and the debounced URL-writer (`war-map.tsx:1040-1071`, `history.replaceState`) then rewrites the URL, **permanently erasing** the shared preset/zoom/layers for the recipient.
- **Why this is not a false positive:** Write path serializes everything, merge path keeps only `aisMode`, `hydrateFromRemote` fully replaces the store, and the trigger (`UserUiSettingsSync`) is always mounted and gated behind a network round-trip so it deterministically wins the race. The asymmetry is confirmed by the codebase's own test.
- **Suggested Fix:** Make `mergeWarMapSettingsWithUrlState` apply **all** parsed URL fields over remote settings, or gate the remote hydrate so it does not overwrite fields already present in the URL on first load.
- **Regression Test Idea:** `mergeWarMapSettingsWithUrlState(remote={preset:'asia'}, 'preset=america&zoom=5&layers=flights')` → assert `activePreset==='america'` and zoom/layers reflect the URL.

---

### [P2] C-2 — Scheduler race: cron `scheduleDueSources` and manual `dispatchNow` use disjoint locks + disjoint dedupe namespaces → concurrent scheduling of the same source

- **Area:** queue
- **Files:**
  - `apps/api/src/modules/queue/news-source.scheduler.service.ts:268`
  - `apps/api/src/modules/queue/news-source.scheduler.service.ts:285`
  - `apps/api/src/modules/queue/news-source.scheduler.service.ts:1820`
  - `apps/api/src/modules/queue/news-source.scheduler.service.ts:1835`
  - `apps/api/src/modules/queue/news-source.scheduler.service.ts:4161`
  - `apps/api/src/modules/queue/news-source.scheduler.service.ts:4529`
- **Static Evidence:** `scheduleCron` takes global lock `cron:news-source-scheduler` (268-272); `dispatchNow` takes per-source lock `news-source-dispatch:${sourceId}` (285-288). `withLock` is Redis `SET NX PX` on `lock:${key}`, so `lock:cron:...` and `lock:news-source-dispatch:<id>` never exclude each other. Dedupe keys are in different namespaces too: `computeManualDispatchDedupeKey` ⇒ `news-source:dispatch-minute:...` (1828) vs `computeSchedulerDispatchDedupeKey` ⇒ `news-source:dispatch-window:...` (1844), so `setIfAbsent` in one path never blocks the other. The only overlap guard is a read of active `pipelineJob` rows (dispatch 377-394; cron 4161-4178) — a classic TOCTOU — with the `tx.pipelineJob.create` happening in a *later* transaction (cron 4531; dispatch 640). The `crawlTask` is deduped by `(orgId,newsSourceId,targetUrl)` and reused, and `crawlTaskConfig.pipelineJobId` is overwritten by whichever transaction commits last (4558 / 672). `enqueueTask` dedups the BullMQ job by `crawl-task:${taskId}:${queueClass}`, so the shared task enqueues **one** crawl.
- **Trigger Path:** User clicks "refresh now" (`dispatchNow` via `news-source-dispatch.controller.ts:19`) for a source at roughly the same moment the 30s `@Cron("*/30 * * * * *")` tick selects that same due source. Both pass the in-flight check, both create a `pipelineJob`, both point the single shared `crawlTask` at their own `pipelineJob`.
- **Impact:** Two `pipelineJob` rows for one crawl. The deduped crawl runs once and, via `task.config.pipelineJobId`, only transitions the last-writer `pipelineJob` to `completed`; the other lingers in `queued`/`running` until `inFlightLookbackMs` elapses — inflating in-flight counts, blocking the source from scheduling during that window, and skewing pipeline metrics/alerts. (Transient/self-healing → P2.)
- **Why this is not a false positive:** The lock keys and dedupe-key prefixes are literally different strings, so neither mutual-exclusion mechanism spans both paths; the in-flight check is read-then-act with the write in a later, non-atomic transaction across the two concurrent callers.
- **Suggested Fix:** Use a single shared per-source lock (`news-source-dispatch:${sourceId}`) for **both** the cron per-source body and `dispatchNow`, or a single shared dedupe-key namespace checked by both; alternatively a DB uniqueness/upsert on `(sourceId, urlFingerprint, active-window)`.
- **Regression Test Idea:** Invoke `scheduleDueSources` and `dispatchNow` for the same source concurrently with a stubbed clock; assert exactly one non-terminal `pipelineJob` remains after the crawl completes.

---

### [P3] D-1 — `item(id)` is schema-nullable with a dedicated FE not-found empty state, but the resolver throws `NotFoundException` on miss

- **Area:** contract
- **Files:**
  - `apps/api/src/graphql/resolvers/items.resolver.ts:605`
  - `apps/api/src/graphql/resolvers/items.resolver.ts:613`
  - `apps/api/src/modules/items/items.service.ts:3683`
  - `apps/api/schema.gql:2161`
  - `apps/web/graphql/items.graphql:106`
  - `apps/web/app/(app)/items/[id]/item-detail.tsx:336`
  - `apps/web/app/(app)/items/[id]/item-detail.tsx:871`
- **Static Evidence:** `schema.gql:2161` declares `item(id: String!): ItemModel` (nullable). Resolver (`605`) is `@Query(() => ItemModel, { nullable: true })` but line 613 does `return this.toItemModel(meta)` unconditionally, and `toItemModel` (931-950) dereferences `meta.id/.name`. The data source `items.service.getItemMeta` throws on both branches (`3674-3676` read-model, `3683-3685` Prisma `if (!itemMeta) throw new NotFoundException`), with the query scoped `findFirst({ where:{ id, orgId } })` — so the resolver **never** returns null on a miss; it raises a 404 → GraphQL error `extensions.code NOT_FOUND`. Sibling nullable queries return null on the same miss: `processed-item.resolver.ts:49-51` and `news-events.resolver.ts:211-213`. FE consumes it as nullable: `item-detail.tsx:336` `const item = data?.item ?? null;`, with a separate error branch at `871-873` that renders a bare red `error.message` and short-circuits the intended "Item not found." empty state (`875-884`). `useItemQuery` has no `errorPolicy` override (default `none`), and `apollo-client.ts:134` fires `captureClientError` for every GraphQL error.
- **Trigger Path:** User opens `/items/[id]` with an id that doesn't resolve in their org (deleted item, stale bookmark, or cross-org item — `getItemMeta` filters by `orgId`). Guards pass, then `getItemMeta` throws `NotFoundException`.
- **Impact:** The nullable-contract not-found empty state (`data?.item ?? null`) is unreachable dead code; the component falls into the generic error branch (bare red string, no page layout), and the Apollo error link emits `captureClientError` telemetry for every not-found item view — recurring error-noise for a normal condition.
- **Why this is not a false positive:** Both sides read directly: resolver typed nullable yet unconditionally maps a value the service guarantees non-null by throwing; two sibling nullable queries return null on the same miss (the intended contract); FE has an explicit `?? null` path the throw bypasses. Trigger (deleted/cross-org/stale id) is ordinary.
- **Suggested Fix:** Make `item(id)` return null on miss (`getItemMetaOrNull`, then `if (!meta) return null`) to honor the nullable schema. *Alternatively* change the schema field to `ItemModel!` and drive the FE not-found state from `extensions.code NOT_FOUND` instead of `data.item === null`.
- **Regression Test Idea:** Query `item(id:<non-existent-or-other-org-id>)`; assert `{ data:{ item: null } }` with no errors (mirroring the existing `processedItemById` null-on-miss test).

---

### [P3] F-2 — NewsNow UI preferences persist into a new org's server slot on org switch (global localStorage key + null-remote branch never resets the store)

- **Area:** frontend
- **Files:**
  - `apps/web/app/(app)/newsnow/store/newsnow-store.ts:606`
  - `apps/web/app/(app)/newsnow/hooks/use-newsnow-ui-sync.ts:97`
  - `apps/web/app/(app)/newsnow/hooks/use-newsnow-ui-sync.ts:121`
  - `apps/web/app/(app)/newsnow/hooks/use-newsnow-ui-sync.ts:159`
- **Static Evidence:** `newsnow-store.ts` persists with `name:"newsnow-storage"` (606) into `window.localStorage` (607-621), partializing focusSources/columnOrders/sortMode/densityMode/sourceAffinity (622-629) — the key is **not** scoped by `orgId`/`userId`. In `use-newsnow-ui-sync.ts` the remote-load effect, on a **null** remote response, does `lastSavedFingerprintRef.current = null` **without** calling `replacePreferences`/reset (101-103) and sets `hydratedRef=true` (104). The save effect (121-151) then computes `nextFingerprint` from the still-populated store and PUTs `{ settings }` to `user-settings/ui/newsnow`. The server keys the record by `user.orgId` AND `user.id` (`user-ui-settings.controller.ts:81,90`), so this writes Org A's prefs into Org B's `(orgId,userId)` slot. Org switch changes `accessToken` (a fetch-effect dep at 119), re-running the fetch into the null branch.
- **Trigger Path:** User personalizes NewsNow under Org A → persisted to global `newsnow-storage`. Switches to Org B (no NewsNow settings yet). NewsNow mounts, fetch returns null → Org A's rehydrated prefs kept → debounced save uploads them to Org B.
- **Impact:** Org A's NewsNow layout/focus/affinity leaks into and is persisted server-side for Org B, and transiently renders under the wrong org. *Verifier nuance:* the data is the same user's own non-sensitive UI-layout prefs across their own org contexts (not cross-user/cross-tenant exposure) → **P3**.
- **Why this is not a false positive:** The persist key is a single constant string with no org/user suffix; the null-remote branch provably skips `replacePreferences`/reset while the save effect uploads current store state. The org-scoped `user-ui-settings-sync.tsx` covers only `situation-monitor`/`war-map`, so NewsNow is the inconsistent path.
- **Suggested Fix:** Reset the NewsNow store to defaults when remote returns null before allowing saves, and/or scope the persist key and fetch/save effects by `${orgId}:${userId}` (mirroring `buildCacheKey` in `user-ui-settings-sync.tsx`).
- **Regression Test Idea:** Seed `newsnow-storage` with Org A prefs, mock GET `user-settings/ui/newsnow` → null for Org B, mount hook; assert no PUT of Org A prefs and store equals defaults.

---

### [P3] C-5 — Scheduler commits `pipelineJob`+`crawlTask` (`pending`) before enqueuing the BullMQ job; a crash in the gap orphans a `pending` task the janitor never reclaims

- **Area:** queue
- **Files:**
  - `apps/api/src/modules/queue/news-source.scheduler.service.ts:4529`
  - `apps/api/src/modules/queue/news-source.scheduler.service.ts:4624`
  - `apps/api/src/modules/crawl/crawl-task-janitor.service.ts:123`
- **Static Evidence:** In `scheduleDueSources` the `$transaction` creates the `pipelineJob` and `crawlTask` with status `pending` and commits (4529-4622); only **after** the transaction does it `await this.crawlQueue.enqueueTask(...)` then flip `crawlTask.updateMany({ status:'queued' })` (4624-4638). The `catch` at 4648 handles a *thrown* enqueue error (marks `failed`), so the uncovered window is a hard process crash between commit and the `updateMany`. The janitor only scans recoverable states: `findStaleQueuedTasks` filters `status:'queued'` (124-137) and `findStaleRunningTasks` filters `status:'running'` (87-118) — **no path reclaims `pending`**. `onModuleInit` (238-240) only migrates a cache TTL; `crawl-frontier.service.ts:860`'s pending/queued/running query targets `crawlFrontierNode`, not `crawlTask`.
- **Trigger Path:** The process is SIGKILLed/OOMs after the `pipelineJob`+`crawlTask` transaction commits but before `enqueueTask`/`updateMany('queued')`. The `crawlTask` stays `pending` with no BullMQ job and no janitor coverage.
- **Impact:** That crawl never runs from this tick and the `crawlTask` lingers indefinitely in `pending`. Partial self-heal only if a later tick reuses the same `(orgId,newsSourceId,targetUrl)` task and re-enqueues it; otherwise it is an orphaned, never-crawled row.
- **Why this is not a false positive:** The `queued` status write is provably outside/after the committing transaction, and the janitor WHERE clauses provably exclude `pending`, so a crash in this window yields a state no scheduled cleanup handles.
- **Suggested Fix:** Have the janitor also reclaim `pending` tasks past a timeout (re-enqueue or fail them), or move the enqueue into an outbox/transactionally-guaranteed step so `pending` cannot persist without a queue job.
- **Regression Test Idea:** Create a `crawlTask` in `pending` with old `updatedAt` and no BullMQ job; run the janitor and assert it re-enqueues or fails the task instead of ignoring it.

---

### [P3] C-3 — Cleanup outbox can permanently orphan MongoDB crawl content: MySQL rows deleted immediately, Mongo cleanup only via drain that gives up after 10 attempts (`dead`)

- **Area:** data
- **Files:**
  - `apps/api/src/modules/crawl/crawl-task.service.ts:212`
  - `apps/api/src/modules/crawl/crawl-cleanup-outbox.service.ts:92`
  - `apps/api/src/modules/crawl/crawl-cleanup-outbox.service.ts:208`
  - `apps/api/src/modules/crawl/crawl-cleanup-outbox.service.ts:237`
  - `apps/api/src/modules/crawl/crawl-result.service.ts:904`
- **Static Evidence:** `deleteTask` deletes the MySQL side (`crawlResult` rows + `crawlTask`) and writes the outbox row in **one** transaction (`crawl-task.service.ts:212-244`) — the correct producer half. The Mongo side (`CrawlResultContentModel` + `TaskLog`) is only deleted later by the drain: `deliverOutboxPayload` calls `resultService.deleteTaskResults(taskId, orgId)` then deletes the outbox row (`crawl-cleanup-outbox.service.ts:104-105`). On repeated failure, `markOutboxFailure` escalates to `markOutboxDead` once `attempts >= outboxMaxAttempts` (=10) (208-235), setting status `dead` and never retrying (the retry query excludes `dead`, 149-169). `deleteTaskResults` (`crawl-result.service.ts:904-912`) is the only path that removes the Mongo docs. The `dead` status feeds only metrics (`pipeline-metric.provider.ts:161`), with no reconciliation.
- **Trigger Path:** A crawl task is deleted; MySQL `crawlResult` rows vanish at commit; the outbox drain repeatedly fails to reach MongoDB (Mongo outage or persistent error in `deleteTaskResults`) for 10 attempts → the entry is marked `dead`, while the `CrawlResultContentModel` docs (and TaskLogs) for that `taskId` remain forever with no parent MySQL row.
- **Impact:** Permanent orphaned Mongo documents (storage leak + dangling content no `crawlResult` references). Because the parent MySQL rows are already gone, no automated reconciliation ever cleans them once the outbox row is `dead`. (Requires sustained infra failure across the backoff window; operators are alerted via the `mongo_outbox.dead` metric → P3.)
- **Why this is not a false positive:** `markOutboxDead` is terminal with no re-enqueue and no compensating reconciliation for `cleanup_crawl_results`; the Mongo deletion is strictly downstream of the already-committed MySQL deletion, so a `dead` row means the two stores stay diverged.
- **Suggested Fix:** Raise/remove the max-attempts cap for idempotent cleanup deliveries (`deleteTaskResults` is safe to retry indefinitely), or add a reconciliation sweep that deletes `CrawlResultContentModel` docs whose `taskId` has no matching `crawlTask`/`crawlResult`, and alert on `dead` `cleanup_crawl_results` rows.
- **Regression Test Idea:** After the outbox reaches `dead`, a reconciliation job removes `CrawlResultContentModel` docs with no matching MySQL `crawlResult`; and `deleteTaskResults` failures are retried without a hard 10-attempt give-up.

---

### [P3] C-4 — Realtime COMPLETED/FAILED queue events can be silently lost (removeOnComplete + per-instance in-memory PubSub + getJob-after-removal)

- **Area:** realtime
- **Files:**
  - `apps/api/src/modules/queue/queue-event.publisher.ts:40`
  - `apps/api/src/modules/queue/queue-event.publisher.ts:48`
  - `apps/api/src/modules/queue/queue-event.publisher.ts:142`
  - `apps/api/src/modules/queue/queue.service.ts:99`
- **Static Evidence:** `enqueueItem` adds pipeline jobs with `removeOnComplete: true` (`queue.service.ts:99`), so a completed job is deleted from Redis before the completed handler runs. `handleCompleted` (`queue-event.publisher.ts:48-63`) resolves org context via `resolveJobContext → this.queue.getJob(jobId)` (142-156), which returns null after removal, then falls back to a **per-instance** in-memory cache populated only during the `active` event. Events are published through a local `new PubSub()` (40), not a Redis-backed pubsub, so each API instance only fans out to subscribers connected to it. The GraphQL subscription path (`dashboard.resolver.ts:155 queueEventsSubscription → queueEvents.asyncIterator(orgId)`) uses this in-memory PubSub. *Verifier note:* the Socket.IO path IS covered cross-instance by `RedisIoAdapter` (`main.ts:75-94`), so the confirmed gap is specifically the **GraphQL subscription** path when an instance has a cold cache.
- **Trigger Path:** In a multi-instance deployment (rolling deploy / autoscale-up), a GraphQL subscriber is connected to an API instance that never observed/cached the job's `active` event; it receives the broadcast `completed` event, `getJob` returns null (job removed) and its local cache is cold → `context.orgId` is undefined → the event is dropped by the guard at 120-122.
- **Impact:** Clients can miss terminal pipeline status updates (a finished/failed job appears stuck `active`/`processing` in the UI) because delivery depends on a race between `removeOnComplete` and a per-instance cache that is not guaranteed warm on every instance. Clients can recover by re-querying stats → P3.
- **Why this is not a false positive:** `removeOnComplete:true`, `resolveJobContext`'s getJob-first-then-per-instance-cache fallback, and the local in-memory `PubSub` are all in the code; the existence of the Redis Socket.IO adapter confirms multi-instance is the intended deployment, substantiating the cold-cache trigger. The GraphQL subscription PubSub is *not* Redis-backed, so no upstream mechanism neutralizes that path.
- **Suggested Fix:** Capture the org context from the event payload/`returnvalue` rather than re-fetching a possibly-removed job, or persist a `jobId → context` map in Redis, and use a Redis-backed PubSub so terminal GraphQL-subscription events reach subscribers regardless of which instance handled `active`.
- **Regression Test Idea:** Simulate a completed event where `getJob` returns null and the local cache is empty; assert the publisher still emits a COMPLETED payload with the correct `orgId` (from `returnvalue`/persisted context) rather than dropping it.

---

## Rejected / Low-confidence Findings

These were raised by reviewers but **dropped after adversarial verification**. Recorded here so they are not re-litigated.

### [Rejected] C-1 — "Memory-pressure requeue vs runTask terminal-fail divergence auto-disables a healthy source" (originally P1)

- **Files:** `apps/api/src/modules/crawl/crawl-execution.service.ts:768,6983` · `crawl.processor.ts:602,707`
- **Why rejected:** The claim rests on `isRetryableStatus` classifying the memory-pressure error as non-retryable. It does not. `isRetryableStatus` (`crawl-execution.service.ts:6987`) checks the **HTTP status code first** against `retryableStatusCodes {408,423,425,429,500,502,503,504}` before falling through to message hints. The memory-pressure error carries status **500** (`crawl4ai.client.ts:358-362`; the team's own `crawl.processor.spec.ts:378` models it as `Crawl4aiRequestException('...memory at 96%...', 500)`), so `retryable=true` → `shouldRetry=true` → `crawlTask` becomes `queued` (not `failed`), `pipelineJob` `delayed` (not `failed`), and the `!shouldRetry` guard at 864 is false, so `markSourceFailureState` is never called — no circuit break, no auto-disable, no double counting. The finding overlooked the status-code branch.

### [Rejected] E-4 — "Concurrent NextAuth session reads trigger parallel refresh → spurious forced logout" (originally P2)

- **Files:** `apps/web/lib/auth.ts:112,366` · `apollo-auth-sync.tsx:46` · `api-client.ts:53`
- **Why rejected:** The client-side facts (multiple un-deduped refresh entry points; hard logout on refresh 401) are accurate, but the decisive premise — "with rotation the backend consumes the refresh token on the first call and rejects the second concurrent call" — is false. The backend wraps refresh in `cache.wrap(cacheKey, graceSeconds, …)` keyed by the **old** refresh token (`auth.service.ts:952-1096`, `cacheKey = auth:refresh:${tokenId}:${secretHash}`, grace default 10s). The first caller acquires a Redis NX lock, rotates, and caches the **success** result; concurrent callers with the same token spin then return that cached success (same new tokens, HTTP 200) — they never reach the revoked/blacklist 401 branch. This grace-window + distributed-lock idempotency is purpose-built to reconcile single-use rotation with concurrent refreshes. No forced logout materializes.

### [Rejected] E-3 — "GraphQL-WS subscriptions on a singleton client cannot recover after an auth-fatal socket close" (originally P3, low confidence)

- **Files:** `apps/web/lib/apollo-client.ts:161,169,211` · `assistant-content.tsx:495` · `analysis-feed-context.tsx:126`
- **Why rejected:** The permanent-breakage scenario requires the server to close the WS with an auth-fatal 44xx code on token rotation. It does not: `graphql.module.ts:219-236` configures `graphql-ws` with only an `onConnect` that stashes connection params — it never validates or closes the socket; per-operation auth failures surface as `GraphQLError` over the open socket, not a fatal close (grep found no `CloseCode`/`ws.close`/`onDisconnect`/token-expiry-close logic in `apps/api/src`). Additionally, `graphql-ws@5.16.2` defaults to `retryAttempts:5` with a retry-on-non-fatal `shouldRetry`, re-reading `connectionParams` (fresh token) on each reconnect. The only non-recovering case (fatal 44xx) is exactly the case the server never produces.

### [Uncertain] F-4 — "Global dashboard range/sector URL sync clobbers war-map's `history.replaceState` params" (originally P2 → downgraded)

- **Files:** `apps/web/app/(app)/components/shell.tsx:172` · `url-state-sync.tsx:6` · `use-dashboard-range-url-sync.ts:91` · `use-dashboard-sector-url-sync.ts:46` · `war-map.tsx:1046`
- **Verdict:** Compound claim — one half real & minor, the half justifying P2 is refuted.
  - **True (minor, ~P3):** `UrlStateSync` is mounted globally in `ShellLayout` (`shell.tsx:172`) and both hooks run unconditionally with no route guard; `selectedSector`/non-default `range` persist in a plain Zustand singleton, so navigating to `/settings`, `/situation-monitor`, `/newsnow`, `/admin` appends `?sector=…`/`?range=…` to pages that never own them (**cosmetic URL pollution**).
  - **Refuted (the P2 mechanism):** the "war-map param wipe" premise ("`useSearchParams` does not observe `history.replaceState`") is false on **Next 15.5.6** (`package.json:46`) — since Next 14.1 native `history.pushState/replaceState` integrate with the App Router and sync `useSearchParams`. Moreover neither writer deletes the other's keys (sync only sets/deletes `range/start/end` or `sector`; `writeWarMapUrlState` copies `search` verbatim), so they are mutually preserving. No data loss.
  - **Action:** treat only the URL-pollution half as a real (low-priority) issue; add a `pathname.startsWith('/dashboard')` guard to the two sync hooks.

---

## Recommended Fix Order

Ordered by risk × (inverse) change cost — cheap, high-impact isolation/auth fixes first, higher-cost durability/realtime work last.

| Order | ID | Sev | Rationale |
|:-----:|----|:---:|-----------|
| 1 | **E-1** | P2 | Cheapest security win — one localized same-origin/allowlist check on `callbackUrl` before `router.push` closes a post-auth open redirect. |
| 2 | **B-2** | P2 | High impact (cross-tenant rename/slug-squat/DoS), low cost — rebind the `org.write`/admin check to the **target** `orgId` in `updateOrg`/`setOrgActive`. |
| 3 | **B-1** | P2 | High-impact cross-tenant IDOR, low cost — add an `orgId` predicate to the alert-rule lookup in `triggerAlertRule`. |
| 4 | **F-1** | P2 | Stops cross-tenant data display with a small change — `client.clearStore()`/`resetStore()` (or rebuild the client) on org switch. |
| 5 | **E-2** | P2 | Config-level — extend the middleware matcher to all protected routes (or centralize the `RefreshAccessTokenError` redirect). |
| 6 | **D-1** | P3 | Near one-line contract fix — return `null` from `item(id)` on miss instead of throwing; restores the nullable empty state, kills error telemetry noise. |
| 7 | **F-2** | P3 | Moderate client fix mirroring the situation-monitor/war-map pattern — reset NewsNow store + org-scope its localStorage key on org change. |
| 8 | **F-3** | P2 | Moderate — fix hydration precedence so URL-derived war-map view/preset/layers win over (or merge with) server settings. |
| 9 | **C-2** | P2 | Higher-cost concurrency work — unify cron `scheduleDueSources` and `dispatchNow` onto a shared lock + single dedupe namespace. |
| 10 | **C-5** | P3 | Ordering/reclaim change — enqueue before (or in the same durable step as) committing the `pending` `crawlTask`, and/or extend the janitor to reclaim long-`pending` tasks. |
| 11 | **C-3** | P3 | Reconciliation mechanism — defer the MySQL delete until Mongo cleanup confirms, or add a reaper for `dead` outbox rows. |
| 12 | **C-4** | P3 | Most architectural — make terminal COMPLETED/FAILED delivery durable (avoid the `removeOnComplete`/`getJob` race + per-instance in-memory PubSub for the GraphQL subscription path). |

> Note on ordering: F-3 (P2) is sequenced at #8 (after two P3s) purely on cost — it needs hydration-precedence rework, whereas D-1/F-2 are near-mechanical. All P2 authorization/isolation items (E-1, B-2, B-1, F-1, E-2) remain the top block.

---

<sub>Static-only audit · 7-agent workflow (23 subagents, 552 read-only tool calls) · 16 raw → 12 confirmed / 1 uncertain / 3 rejected · no code was executed or modified.</sub>

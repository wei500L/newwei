# Crawl4AI SSRF Proxy Deployment Guide

## Purpose

`CRAWL4AI_SSRF_PROXY_URL` enables worker-side SSRF protection for Crawl4AI.

Without it:

- the API still validates user-supplied crawl URLs before enqueueing requests
- but the Crawl4AI worker resolves the hostname again when the browser fetches the page
- DNS rebinding protection is therefore incomplete

With it enabled:

- the browser sends target traffic through the worker-local proxy
- the proxy resolves hostnames inside the worker network namespace
- localhost, private, link-local, and metadata targets are blocked at fetch time

## Required Env

Docker deployments should keep these values:

```env
CRAWL4AI_SSRF_PROXY_URL=http://127.0.0.1:18080
CRAWL4AI_SSRF_PROXY_PORT=18080
```

Notes:

- `CRAWL4AI_SSRF_PROXY_URL` must be visible to the API and Web runtimes so health checks and the monitor page report the correct state.
- `CRAWL4AI_SSRF_PROXY_PORT` is container-internal only and should not be published on the host.

## Deploy Steps

1. Update root `.env` and `infra/docker/.env` with the SSRF proxy settings.
2. Ensure the current `infra/docker/docker-compose.yml` mounts `infra/docker/crawl4ai/ssrf_proxy.py`.
3. Recreate Crawl4AI:

```bash
pnpm docker:up:extras -d --force-recreate crawl4ai
```

4. Roll out the Mongo index used by the new facets path:

```bash
pnpm mongo:indexes
```

## Verification

### Monitor UI

Open:

- `http://localhost:3000/admin/ops/crawl-monitor`

Expected:

- `Worker SSRF proxy` shows `OK`
- the quick status card shows `SSRF proxy OK`
- no warning banner about `SSRF proxy OFF` or `SSRF proxy failed`

### API Health

Check:

```bash
curl -fsS -H "Authorization: Bearer <token>" http://localhost:4000/api/healthz | jq .
```

The readiness probe now requires authentication (a user JWT or machine token) to
avoid exposing dependency details and the exact version to anonymous callers.

Expected component:

```json
"crawl4aiSsrfProxy": {
  "status": "up"
}
```

If the proxy is disabled or unreachable, `/api/healthz` will report `crawl4aiSsrfProxy` as down. `/api/healthz/live` stays unaffected and remains public.

### Docker Logs

Check:

```bash
pnpm docker:logs
```

Look for a log line similar to:

```text
[crawl4ai-ssrf-proxy] INFO listening on ('127.0.0.1', 18080)
```

## Troubleshooting

### Monitor shows `SSRF proxy OFF`

- `CRAWL4AI_SSRF_PROXY_URL` is missing in Web and/or API runtime env
- sync both root `.env` and `infra/docker/.env`

### Monitor shows `SSRF proxy failed`

- crawl4ai container did not start the local proxy
- verify the mounted file exists inside the container and recreate the service

### `/api/healthz` fails on `crawl4aiSsrfProxy`

- the proxy is not reachable from the crawl4ai browser runtime
- verify the proxy URL is `http://127.0.0.1:18080`
- check crawl4ai logs for proxy startup errors
- recreate the crawl4ai service after updating env

### Facets are still slow after deployment

- run `pnpm mongo:indexes`
- verify the `ProcessedItem` collection has the `{ orgId, status, itemMetaId, createdAt }` index

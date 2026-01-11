import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MONITOR_TIMEOUT_MS = 8_000;

const GET_ALLOWLIST = new Set<string>([
  'health',
  'requests',
  'browsers',
  'endpoints/stats',
  'timeline',
  'logs/janitor',
  'logs/errors',
]);

const POST_ALLOWLIST = new Set<string>([
  'actions/cleanup',
  'actions/kill_browser',
  'actions/restart_browser',
  'stats/reset',
]);

function normalizeMonitorPath(parts: string[] | undefined): string | null {
  if (!parts || parts.length === 0) return null;
  const cleaned = parts.map((part) => part.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  if (cleaned.some((part) => part === '.' || part === '..' || part.includes('..'))) return null;
  return cleaned.join('/');
}

function hasAnyPermission(permissions: string[], required: string[]): boolean {
  return required.some((perm) => permissions.includes(perm));
}

async function proxyMonitorRequest(request: Request, monitorPath: string) {
  const baseUrl = process.env.CRAWL4AI_BASE_URL?.trim();
  if (!baseUrl) {
    return NextResponse.json(
      { error: 'CRAWL4AI_BASE_URL is not configured' },
      { status: 500 },
    );
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(`/monitor/${monitorPath}`, baseUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid CRAWL4AI_BASE_URL' }, { status: 500 });
  }

  const incomingUrl = new URL(request.url);
  targetUrl.search = incomingUrl.search;

  const headers = new Headers();
  headers.set('accept', request.headers.get('accept') ?? 'application/json');

  const apiKey = process.env.CRAWL4AI_API_KEY?.trim();
  if (apiKey) {
    headers.set('x-api-key', apiKey);
  }

  const contentType = request.headers.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MONITOR_TIMEOUT_MS);

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
      signal: controller.signal,
      cache: 'no-store',
    });

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    const body = await upstream.arrayBuffer();

    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': upstreamContentType,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    return NextResponse.json(
      { error: isAbortError ? 'Crawl4AI monitor request timed out' : 'Crawl4AI monitor request failed' },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET(
  request: Request,
  context: { params: { monitorPath?: string[] } },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const permissions = session.permissions ?? session.user?.permissions ?? [];
  if (!hasAnyPermission(permissions, ['crawl.read', 'crawl.write'])) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const monitorPath = normalizeMonitorPath(context.params.monitorPath);
  if (!monitorPath || !GET_ALLOWLIST.has(monitorPath)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return proxyMonitorRequest(request, monitorPath);
}

export async function POST(
  request: Request,
  context: { params: { monitorPath?: string[] } },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const permissions = session.permissions ?? session.user?.permissions ?? [];
  if (!hasAnyPermission(permissions, ['crawl.write'])) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const monitorPath = normalizeMonitorPath(context.params.monitorPath);
  if (!monitorPath || !POST_ALLOWLIST.has(monitorPath)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return proxyMonitorRequest(request, monitorPath);
}

import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

import type { BackendLoginResponse, TokenPayload } from '@/lib/auth';
import { serverEnv } from '@/lib/env.server';

export async function POST(request: Request) {
  let token: TokenPayload | null = null;

  try {
    token = (await getToken({
      req: request,
      secret: serverEnv.NEXTAUTH_SECRET
    })) as TokenPayload | null;
  } catch {
    token = null;
  }

  if (!token?.refreshToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { orgId?: string; org?: string };
  const orgId = (body.orgId ?? body.org)?.trim();

  if (!orgId) {
    return NextResponse.json({ error: 'Organization is required' }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(`${serverEnv.apiBaseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refreshToken: token.refreshToken, orgId })
    });
  } catch {
    return NextResponse.json({ error: 'Auth service unavailable' }, { status: 502 });
  }

  if (!response.ok) {
    const errorText = await response.text();
    return NextResponse.json(
      { error: 'Failed to switch organization', details: errorText || undefined },
      { status: response.status }
    );
  }

  const data = (await response.json()) as BackendLoginResponse;
  return NextResponse.json(data);
}

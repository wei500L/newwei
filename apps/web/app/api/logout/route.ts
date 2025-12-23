import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

import type { TokenPayload } from '@/lib/auth';
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

  if (!token?.refreshToken || !token.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { logoutAll?: boolean };

  let response: Response;
  try {
    response = await fetch(`${serverEnv.apiBaseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.accessToken}`
      },
      body: JSON.stringify({
        refreshToken: token.refreshToken,
        logoutAll: Boolean(body.logoutAll)
      })
    });
  } catch {
    return NextResponse.json({ error: 'Auth service unavailable' }, { status: 502 });
  }

  if (!response.ok) {
    const errorText = await response.text();
    return NextResponse.json(
      { error: 'Logout failed', details: errorText || undefined },
      { status: response.status }
    );
  }

  return NextResponse.json({ ok: true });
}

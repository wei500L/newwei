import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

import type { TokenPayload } from "@/lib/auth";
import { env } from "@/lib/env";

export async function POST(request: Request) {
  const token = (await getToken({ req: request })) as TokenPayload | null;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { logoutAll?: boolean };

  const response = await fetch(`${env.apiBaseUrl}/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token.accessToken}`
    },
    body: JSON.stringify({
      refreshToken: token.refreshToken,
      logoutAll: Boolean(body.logoutAll)
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    return NextResponse.json(
      { error: "Logout failed", details: errorText || undefined },
      { status: response.status }
    );
  }

  return NextResponse.json({ ok: true });
}

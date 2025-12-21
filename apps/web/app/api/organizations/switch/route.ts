import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

import type { BackendLoginResponse, TokenPayload } from "@/lib/auth";
import { env } from "@/lib/env";

export async function POST(request: Request) {
  const token = (await getToken({ req: request })) as TokenPayload | null;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { orgId?: string };
  const orgId = body.orgId?.trim();

  if (!orgId) {
    return NextResponse.json({ error: "Organization ID is required" }, { status: 400 });
  }

  const response = await fetch(`${env.apiBaseUrl}/auth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ refreshToken: token.refreshToken, orgId })
  });

  if (!response.ok) {
    const errorText = await response.text();
    return NextResponse.json(
      { error: "Failed to switch organization", details: errorText || undefined },
      { status: response.status }
    );
  }

  const data = (await response.json()) as BackendLoginResponse;
  return NextResponse.json(data);
}


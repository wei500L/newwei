import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

import type { BackendLoginResponse, TokenPayload } from '@/lib/auth';
import { serverEnv } from '@/lib/env.server';
import { logServerError } from '@/lib/server-logger';
import { createTraceHeaders } from '@/lib/trace';

const SWITCH_ORG_REFRESH_TIMEOUT_MS = 5_000;
const SWITCH_ORG_REFRESH_MAX_ATTEMPTS = 2;
const SWITCH_ORG_RETRY_DELAY_MS = 150;
const SWITCH_ORG_REPORT_TIMEOUT_MS = 1_500;
const SWITCH_ORG_EVENT_PATH = '/api/organizations/switch';
const SWITCH_ORG_EVENT_OPERATION = 'organization-switch';
const SWITCH_ORG_EVENT_OPERATION_NAME = 'web-api-organization-switch';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ReportSwitchExceptionEventInput {
  traceId: string;
  orgId: string;
  userId: string;
  accessToken?: string;
  statusCode: number;
  message: string;
  error?: unknown;
}

const getErrorDetails = (error: unknown) => {
  if (error instanceof Error) {
    return {
      errorName: error.name
    };
  }

  return {
    errorName: undefined
  };
};

const reportSwitchExceptionEvent = async ({
  traceId,
  orgId,
  userId,
  accessToken,
  statusCode,
  message,
  error
}: ReportSwitchExceptionEventInput) => {
  if (!accessToken) {
    logServerError(
      'Skipped organization switch error report because access token is missing',
      new Error('Missing access token'),
      {
        traceId,
        meta: {
          orgId,
          userId,
          statusCode
        }
      }
    );
    return;
  }

  const reportUrl = `${serverEnv.apiBaseUrl}/observability/exception-events/client`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SWITCH_ORG_REPORT_TIMEOUT_MS);
  const { errorName } = getErrorDetails(error);

  try {
    const response = await fetch(reportUrl, {
      method: 'POST',
      headers: createTraceHeaders({
        'Content-Type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'x-trace-id': traceId
      }),
      body: JSON.stringify({
        kind: 'http',
        traceId,
        statusCode,
        message,
        path: SWITCH_ORG_EVENT_PATH,
        method: 'POST',
        operation: SWITCH_ORG_EVENT_OPERATION,
        operationName: SWITCH_ORG_EVENT_OPERATION_NAME,
        errorName
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(errorText || `Failed to report switch error event (${response.status})`);
    }
  } catch (reportError) {
    logServerError('Failed to report organization switch error event', reportError, {
      traceId,
      meta: {
        orgId,
        userId,
        statusCode,
        reportUrl
      }
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

export async function POST(request: Request) {
  const incomingTraceId = request.headers.get('x-trace-id');
  const requestHeaders = createTraceHeaders(
    incomingTraceId
      ? {
          'Content-Type': 'application/json',
          'x-trace-id': incomingTraceId
        }
      : {
          'Content-Type': 'application/json'
        }
  );
  const traceId = requestHeaders['x-trace-id'] ?? incomingTraceId ?? 'unknown';
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

  const refreshUrl = `${serverEnv.apiBaseUrl}/auth/refresh`;
  let response: Response | null = null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= SWITCH_ORG_REFRESH_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SWITCH_ORG_REFRESH_TIMEOUT_MS);
    try {
      response = await fetch(refreshUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ refreshToken: token.refreshToken, orgId }),
        signal: controller.signal
      });
      break;
    } catch (error) {
      lastError = error;
      const isAbortError = error instanceof Error && error.name === 'AbortError';
      logServerError('Organization switch refresh request failed', error, {
        traceId,
        meta: {
          attempt,
          maxAttempts: SWITCH_ORG_REFRESH_MAX_ATTEMPTS,
          reason: isAbortError ? 'timeout' : 'fetch_error',
          timeoutMs: SWITCH_ORG_REFRESH_TIMEOUT_MS,
          orgId,
          userId: token.user.id,
          apiBaseUrl: serverEnv.apiBaseUrl
        }
      });

      if (attempt < SWITCH_ORG_REFRESH_MAX_ATTEMPTS) {
        await sleep(SWITCH_ORG_RETRY_DELAY_MS);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!response) {
    if (lastError) {
      logServerError('Organization switch failed after retries', lastError, {
        traceId,
        meta: {
          orgId,
          userId: token.user.id,
          apiBaseUrl: serverEnv.apiBaseUrl
        }
      });
    }

    void reportSwitchExceptionEvent({
      traceId,
      orgId,
      userId: token.user.id,
      accessToken: token.accessToken,
      statusCode: 502,
      message: 'Auth service unavailable',
      error: lastError
    });

    return NextResponse.json({ error: 'Auth service unavailable' }, { status: 502 });
  }

  if (!response.ok) {
    const backendTraceId = response.headers.get('x-trace-id') ?? traceId;
    const errorText = await response.text().catch(() => '');
    logServerError(
      'Organization switch rejected by backend',
      new Error(errorText || `HTTP ${response.status}`),
      {
        traceId: backendTraceId,
        meta: {
          status: response.status,
          orgId,
          userId: token.user.id,
          apiBaseUrl: serverEnv.apiBaseUrl
        }
      }
    );
    return NextResponse.json(
      { error: 'Failed to switch organization', details: errorText || undefined },
      { status: response.status }
    );
  }

  const data = (await response.json()) as BackendLoginResponse;
  return NextResponse.json(data);
}

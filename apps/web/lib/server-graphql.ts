import "server-only";

import { createTraceHeaders } from "./trace";
import { serverEnv } from "./env.server";
import { logServerError } from "./server-logger";

interface GraphqlError {
  message?: string;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
}

export async function fetchGraphql<T>(options: {
  query: string;
  variables?: Record<string, unknown>;
  accessToken?: string;
}) {
  const { query, variables, accessToken } = options;
  const headers = {
    "Content-Type": "application/json",
    ...createTraceHeaders(),
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
  };

  let response: Response;
  try {
    response = await fetch(serverEnv.graphqlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      cache: "no-store"
    });
  } catch (error) {
    logServerError("GraphQL request failed", error);
    return null;
  }

  const traceId = response.headers.get("x-trace-id") ?? undefined;

  if (!response.ok) {
    logServerError("GraphQL response not ok", new Error(`Status ${response.status}`), {
      traceId,
      meta: { status: response.status }
    });
    return null;
  }

  let payload: GraphqlResponse<T>;
  try {
    payload = (await response.json()) as GraphqlResponse<T>;
  } catch (error) {
    logServerError("GraphQL response parse failed", error, { traceId });
    return null;
  }

  if (payload.errors && payload.errors.length > 0) {
    logServerError(
      "GraphQL response errors",
      new Error(payload.errors.map((err) => err.message ?? "Unknown error").join("; ")),
      { traceId, meta: { errors: payload.errors } }
    );
  }

  return payload.data ?? null;
}

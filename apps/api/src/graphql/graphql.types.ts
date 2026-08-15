import type { RequestWithIp } from "../common/request-ip";
import type { AuthenticatedUser } from "../modules/auth/auth.service";

export type GqlHeaders = Record<string, string | string[] | undefined>;

export interface GqlRequest extends RequestWithIp {
  user?: AuthenticatedUser;
}

export interface GraphqlWsExtra {
  request?: GqlRequest;
  connectionParams?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}

export interface GraphqlContextFactoryArgs {
  req?: GqlRequest;
  res?: unknown;
  extra?: GraphqlWsExtra;
}

export interface GraphQLContext {
  req: GqlRequest;
  res?: unknown;
  user?: AuthenticatedUser;
  connectionParams?: Record<string, unknown>;
  request?: GqlRequest;
}

export function toGqlHeaders(value: unknown): GqlHeaders {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const headers: GqlHeaders = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" || typeof entry === "undefined") {
      headers[key] = entry;
      continue;
    }
    if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      headers[key] = entry;
    }
  }
  return headers;
}

export function createSyntheticGqlRequest(
  headers: unknown,
  ip?: string,
): GqlRequest {
  return {
    headers: toGqlHeaders(headers),
    ip,
  };
}

export function asGraphqlWsExtra(value: unknown): GraphqlWsExtra {
  if (value && typeof value === "object") {
    return value as GraphqlWsExtra;
  }
  return {};
}

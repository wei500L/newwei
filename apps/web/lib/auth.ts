import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { serverEnv } from "./env.server";
import { logServerError } from "./server-logger";
import { createTraceHeaders } from "./trace";

export interface OrganizationOption {
  id: string;
  name?: string;
  slug?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  orgId: string;
  roleIds: string[];
  permissions: string[];
  organizations?: OrganizationOption[];
  avatarUrl?: string | null;
  planTier?: string | null;
  subscriptionStatus?: string | null;
}

export interface BackendLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
  organizations?: OrganizationOption[];
}

export interface TokenPayload {
  accessToken: string;
  refreshToken: string;
  accessTokenExpires: number;
  user: AuthenticatedUser;
  organizations?: OrganizationOption[];
  error?: string;
}

const REFRESH_TOKEN_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 8_000;

function normalizeOptionalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "undefined" || trimmed === "null") return undefined;
  return trimmed;
}

async function refreshAccessToken(token: TokenPayload): Promise<TokenPayload> {
  let traceId: string | undefined;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REFRESH_TOKEN_TIMEOUT_MS);

  try {
    const response = await fetch(`${serverEnv.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: createTraceHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify({ refreshToken: token.refreshToken, orgId: token.user.orgId }),
      signal: controller.signal
    });
    traceId = response.headers.get("x-trace-id") ?? undefined;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Failed to refresh token");
      throw new Error(errorText || "Failed to refresh token");
    }

    const data = (await response.json()) as BackendLoginResponse;

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? token.refreshToken,
      accessTokenExpires: Date.now() + data.expiresIn * 1000,
      user: data.user,
      organizations: data.organizations ?? token.organizations ?? [{ id: data.user.orgId }]
    };
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === "AbortError";
    const meta: Record<string, unknown> = { userId: token.user.id };

    if (isAbortError) {
      meta.reason = "refresh_token_timeout";
      meta.timeoutMs = REFRESH_TOKEN_TIMEOUT_MS;
    }

    logServerError("Refresh token error", error, {
      traceId,
      meta
    });
    return {
      ...token,
      accessToken: "",
      refreshToken: "",
      accessTokenExpires: 0,
      error: "RefreshAccessTokenError"
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

const config: NextAuthConfig = {
  trustHost: true,
  debug: process.env.NODE_ENV !== "production",
  secret: serverEnv.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt"
  },
  pages: {
    signIn: "/login"
  },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        orgId: { label: "Organization", type: "text", required: false }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
        const orgId = normalizeOptionalId(credentials.orgId);
        const loginUrl = `${serverEnv.apiBaseUrl}/auth/login`;

        try {
          const response = await fetch(loginUrl, {
            method: "POST",
            headers: createTraceHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              email: credentials.email,
              password: credentials.password,
              orgId
            }),
            signal: controller.signal
          });

          const traceId = response.headers.get("x-trace-id") ?? undefined;

          if (!response.ok) {
            const errorText = await response.text().catch(() => "Backend login failed");
            logServerError("Credentials sign-in rejected by backend", new Error(errorText), {
              traceId,
              meta: {
                status: response.status,
                url: loginUrl,
                email: credentials.email,
                orgId: orgId ?? null
              }
            });
            return null;
          }

          const data = (await response.json()) as BackendLoginResponse;
          const organizations = data.organizations ?? [{ id: data.user.orgId }];
          return {
            id: data.user.id,
            email: data.user.email,
            name: `${data.user.firstName} ${data.user.lastName}`,
            ...data,
            organizations
          };
        } catch (error) {
          const isAbortError = error instanceof Error && error.name === "AbortError";
          logServerError("Credentials sign-in request failed", error, {
            meta: {
              reason: isAbortError ? "timeout" : "fetch_error",
              timeoutMs: LOGIN_TIMEOUT_MS,
              url: loginUrl,
              email: credentials.email,
              orgId: orgId ?? null
            }
          });
          return null;
        } finally {
          clearTimeout(timeoutId);
        }
      }
    })
  ],
  callbacks: {
    authorized({ auth }) {
      const session = auth as { error?: TokenPayload["error"] } | null;
      return !!session && session.error !== "RefreshAccessTokenError";
    },
    async jwt({ token, user, trigger, session }) {
      if (user) {
        const typedUser = user as unknown as BackendLoginResponse & {
          id: string;
          email: string;
          name: string;
        };
        return {
          accessToken: typedUser.accessToken,
          refreshToken: typedUser.refreshToken,
          accessTokenExpires: Date.now() + typedUser.expiresIn * 1000,
          user: typedUser.user,
          organizations: typedUser.organizations ?? [{ id: typedUser.user.orgId }]
        } satisfies TokenPayload;
      }

      const typedToken = token as unknown as TokenPayload;

      if (trigger === "update" && session) {
        const updatedSession = session as Partial<TokenPayload> & {
          user?: TokenPayload["user"];
        };
        return {
          ...typedToken,
          accessToken: updatedSession.accessToken ?? typedToken.accessToken,
          refreshToken: updatedSession.refreshToken ?? typedToken.refreshToken,
          accessTokenExpires:
            updatedSession.accessTokenExpires ?? typedToken.accessTokenExpires,
          user: updatedSession.user ?? typedToken.user,
          organizations: updatedSession.organizations ?? typedToken.organizations
        } satisfies TokenPayload;
      }

      if (typedToken.error === "RefreshAccessTokenError") {
        return {
          ...typedToken,
          accessToken: "",
          refreshToken: "",
          accessTokenExpires: 0
        };
      }

      if (Date.now() < typedToken.accessTokenExpires - 30_000) {
        return typedToken;
      }

      return refreshAccessToken(typedToken);
    },
    async session({ session, token }) {
      const typedToken = token as unknown as TokenPayload;
      return {
        ...session,
        user: {
          ...typedToken.user,
          organizations: typedToken.organizations,
          image: typedToken.user.avatarUrl ?? null
        },
        accessToken: typedToken.accessToken,
        accessTokenExpires: typedToken.accessTokenExpires,
        permissions: typedToken.user.permissions,
        orgId: typedToken.user.orgId,
        organizations: typedToken.organizations ?? [{ id: typedToken.user.orgId }],
        error: typedToken.error
      };
    }
  }
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);

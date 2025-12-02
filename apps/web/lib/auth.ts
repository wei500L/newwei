import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { env } from "./env";

export type OrganizationOption = {
  id: string;
  name?: string;
  slug?: string;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  orgId: string;
  roleIds: string[];
  permissions: string[];
  organizations?: OrganizationOption[];
};

export type BackendLoginResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
  organizations?: OrganizationOption[];
};

export type TokenPayload = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpires: number;
  user: AuthenticatedUser;
  organizations?: OrganizationOption[];
  error?: string;
};

async function refreshAccessToken(token: TokenPayload): Promise<TokenPayload> {
  try {
    const response = await fetch(`${env.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ refreshToken: token.refreshToken, orgId: token.user.orgId })
    });

    if (!response.ok) {
      throw new Error("Failed to refresh token");
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
    console.error("Refresh token error", error);
    return {
      ...token,
      accessToken: "",
      refreshToken: "",
      accessTokenExpires: 0,
      error: "RefreshAccessTokenError"
    };
  }
}

const config: NextAuthConfig = {
  secret: env.NEXTAUTH_SECRET,
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
        const response = await fetch(`${env.apiBaseUrl}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: credentials.email,
            password: credentials.password,
            orgId: credentials.orgId || undefined
          })
        });

        if (!response.ok) {
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
      }
    })
  ],
  callbacks: {
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

      if (Date.now() < typedToken.accessTokenExpires - 30_000) {
        return typedToken;
      }

      return refreshAccessToken(typedToken);
    },
    async session({ session, token }) {
      const typedToken = token as unknown as TokenPayload;
      if (typedToken.error === "RefreshAccessTokenError") {
        return null;
      }
      return {
        ...session,
        user: {
          ...typedToken.user,
          organizations: typedToken.organizations
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

import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { env } from "./env";

type BackendLoginResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    orgId: string;
    roleIds: string[];
    permissions: string[];
  };
};

type TokenPayload = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpires: number;
  user: BackendLoginResponse["user"];
  error?: string;
};

async function refreshAccessToken(token: TokenPayload): Promise<TokenPayload> {
  try {
    const response = await fetch(`${env.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ refreshToken: token.refreshToken })
    });

    if (!response.ok) {
      throw new Error("Failed to refresh token");
    }

    const data = (await response.json()) as BackendLoginResponse;

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? token.refreshToken,
      accessTokenExpires: Date.now() + data.expiresIn * 1000,
      user: data.user
    };
  } catch (error) {
    console.error("Refresh token error", error);
    return {
      ...token,
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
        password: { label: "Password", type: "password" }
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
            password: credentials.password
          })
        });

        if (!response.ok) {
          return null;
        }

        const data = (await response.json()) as BackendLoginResponse;
        return {
          id: data.user.id,
          email: data.user.email,
          name: `${data.user.firstName} ${data.user.lastName}`,
          ...data
        };
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }) {
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
          user: typedUser.user
        } satisfies TokenPayload;
      }

      const typedToken = token as unknown as TokenPayload;

      if (Date.now() < typedToken.accessTokenExpires - 30_000) {
        return typedToken;
      }

      return refreshAccessToken(typedToken);
    },
    async session({ session, token }) {
      const typedToken = token as unknown as TokenPayload;
      return {
        ...session,
        user: typedToken.user,
        accessToken: typedToken.accessToken,
        permissions: typedToken.user.permissions,
        orgId: typedToken.user.orgId,
        error: typedToken.error
      };
    }
  }
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);

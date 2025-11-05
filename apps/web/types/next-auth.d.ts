import NextAuth from "next-auth";

declare module "next-auth" {
  interface Session {
    accessToken: string;
    permissions: string[];
    orgId: string;
    error?: string;
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      orgId: string;
      permissions: string[];
      roleIds: string[];
    };
  }

  interface User {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: Session["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken: string;
    refreshToken: string;
    accessTokenExpires: number;
    user: NextAuth.Session["user"];
    error?: string;
  }
}

import NextAuth from "next-auth";

type SessionOrganization = {
  id: string;
  name?: string;
  slug?: string;
};

declare module "next-auth" {
  interface Session {
    accessToken: string;
    accessTokenExpires?: number;
    permissions: string[];
    orgId: string;
    organizations?: SessionOrganization[];
    refreshToken?: string;
    error?: string;
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      orgId: string;
      permissions: string[];
      roleIds: string[];
      organizations?: SessionOrganization[];
    };
  }

  interface User {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: Session["user"];
    organizations?: SessionOrganization[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken: string;
    refreshToken: string;
    accessTokenExpires: number;
    user: NextAuth.Session["user"];
    organizations?: SessionOrganization[];
    error?: string;
  }
}

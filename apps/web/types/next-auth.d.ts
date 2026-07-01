import NextAuth from "next-auth";

type SessionOrganization = {
  id: string;
  name?: string;
  slug?: string;
  isActive?: boolean;
};

type GlobalRole = string;

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
      emailVerified?: string | null;
      lastLoginAt?: string | null;
      pendingEmail?: string | null;
      firstName: string;
      lastName: string;
      orgId: string;
      primaryRoleId?: string | null;
      permissions: string[];
      roleIds: string[];
      organizations?: SessionOrganization[];
      avatarUrl?: string | null;
      isActive?: boolean;
      planTier?: string | null;
      subscriptionStatus?: string | null;
      globalRoles?: GlobalRole[];
      mfaEnabled?: boolean;
      mfaRequired?: boolean;
      mfaEnrollmentRequired?: boolean;
      image?: string | null;
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

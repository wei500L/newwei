import { Injectable, UnauthorizedException, BadRequestException } from "@nestjs/common";
import bcrypt from "bcrypt";
import { decode, sign } from "jsonwebtoken";
import crypto from "node:crypto";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { OrgService } from "../org/org.service";
import { RateLimitConfigService } from "../system-settings/rate-limit-config.service";

import { AccessTokenBlacklistService } from "./access-token-blacklist.service";
import { AuthCacheSettingsService } from "./auth-cache-settings.service";

export interface JwtPayload {
  sub: string;
  orgId: string;
  permissions: string[];
  jti?: string;
  exp?: number;
  iat?: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  orgId: string;
  roleIds: string[];
  permissions: string[];
  firstName: string;
  lastName: string;
  accessTokenId?: string;
  accessTokenExpiresAt?: number;
}

interface MembershipRolePermission {
  permission?: { name?: string | null };
}

interface MembershipRole {
  permissions?: MembershipRolePermission[];
}

interface MembershipRoleLink {
  roleId?: string | null;
  role?: MembershipRole | null;
}

interface MembershipRecord {
  roleId?: string | null;
  roles?: MembershipRoleLink[] | null;
  role?: MembershipRole | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly rateLimiter: RateLimiterService,
    private readonly rateLimitConfig: RateLimitConfigService,
    private readonly cache: CacheService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly authCacheSettings: AuthCacheSettingsService,
    private readonly orgService: OrgService
  ) {}

  private async validateRateLimit(identifier: string) {
    const { limit, windowSeconds } = await this.rateLimitConfig.getBucketConfig("login");
    const allowed = await this.rateLimiter.consume(identifier, limit, windowSeconds);
    if (!allowed) {
      throw new TooManyRequestsException("Too many login attempts. Please try again later.");
    }
  }

  private pickMembership<
    T extends { orgId: string; org?: { isActive: boolean; slug?: string } | null }
  >(memberships: T[], orgIdOrSlug?: string): T {
    if (memberships.length === 0) {
      throw new UnauthorizedException("User is not assigned to an organization");
    }
    if (!orgIdOrSlug) {
      if (memberships.length === 1) {
        return memberships[0];
      }

      const activeMemberships = memberships.filter((membership) => membership.org?.isActive ?? true);

      if (activeMemberships.length === 1) {
        return activeMemberships[0];
      }

      if (activeMemberships.length === 0) {
        throw new UnauthorizedException("Organization disabled");
      }

      throw new BadRequestException(
        "Organization is required when a user belongs to multiple organizations"
      );
    }
    const membership = memberships.find(
      (candidate) => candidate.orgId === orgIdOrSlug || candidate.org?.slug === orgIdOrSlug
    );
    if (!membership) {
      throw new UnauthorizedException("User is not assigned to the specified organization");
    }
    return membership;
  }

  private buildMembershipClaims(membership: MembershipRecord): Pick<AuthenticatedUser, "roleIds" | "permissions"> {
    const roleIds = new Set<string>();
    const permissions = new Set<string>();

    const roleLinks = Array.isArray(membership?.roles) ? membership.roles : [];
    if (roleLinks.length > 0) {
      for (const link of roleLinks) {
        if (typeof link?.roleId === "string") {
          roleIds.add(link.roleId);
        }
        const rolePermissions = Array.isArray(link?.role?.permissions) ? link.role.permissions : [];
        for (const rolePermission of rolePermissions) {
          const name = rolePermission?.permission?.name;
          if (typeof name === "string") {
            permissions.add(name);
          }
        }
      }
    } else {
      if (typeof membership?.roleId === "string") {
        roleIds.add(membership.roleId);
      }
      const rolePermissions = Array.isArray(membership?.role?.permissions)
        ? membership.role.permissions
        : [];
      for (const rolePermission of rolePermissions) {
        const name = rolePermission?.permission?.name;
        if (typeof name === "string") {
          permissions.add(name);
        }
      }
    }

    return {
      roleIds: Array.from(roleIds),
      permissions: Array.from(permissions)
    };
  }

  async validateUser(email: string, password: string, orgId?: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          orderBy: { createdAt: "asc" },
          include: {
            org: true,
            roles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: {
                        permission: true
                      }
                    }
                  }
                }
              }
            },
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true
                  }
                }
              }
            }
          }
        }
      }
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const primaryMembership = this.pickMembership(user.memberships, orgId);
    if (!primaryMembership.org?.isActive) {
      throw new UnauthorizedException("Organization disabled");
    }

    const { roleIds, permissions } = this.buildMembershipClaims(primaryMembership);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      orgId: primaryMembership.orgId,
      roleIds,
      permissions
    };
  }

  private signAccessToken(user: AuthenticatedUser) {
    const jwtConfig = this.env.jwtConfig;
    const payload: JwtPayload = {
      sub: user.id,
      orgId: user.orgId,
      permissions: user.permissions
    };
    const token = sign(payload, jwtConfig.secret, {
      expiresIn: jwtConfig.accessExpiresIn,
      audience: jwtConfig.audience,
      issuer: jwtConfig.issuer,
      jwtid: crypto.randomUUID()
    });
    const decoded = decode(token) as { exp?: number } | null;
    const expiresIn = decoded?.exp ? decoded.exp * 1000 : undefined;
    return { token, expiresAt: expiresIn };
  }

  private async signRefreshToken(user: AuthenticatedUser, ipAddress?: string, userAgent?: string) {
    const jwtConfig = this.env.jwtConfig;
    const secret = crypto.randomBytes(32).toString("hex");
    const tokenId = crypto.randomUUID();

    const tokenHash = await bcrypt.hash(secret, 10);
    const expiresAt = new Date(Date.now() + this.parseTimespan(jwtConfig.refreshExpiresIn));

    await this.prisma.refreshToken.create({
      data: {
        id: tokenId,
        userId: user.id,
        tokenHash,
        expiresAt,
        ipAddress,
        userAgent
      }
    });

    return {
      token: user.orgId ? `${tokenId}.${user.orgId}.${secret}` : `${tokenId}.${secret}`,
      expiresAt
    };
  }

  private parseTimespan(timespan: string) {
    const match = /^(\d+)([smhd])$/.exec(timespan);
    if (!match) {
      throw new BadRequestException("Invalid timespan format");
    }
    const value = Number(match[1]);
    const unit = match[2];
    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      default:
        return value * 1000;
    }
  }

  // Refresh tokens follow tokenId[.orgId].secret so we can unambiguously recover each segment.
  private parseRefreshToken(refreshToken: string) {
    const tokenPattern =
      /^(?<tokenId>[A-Za-z0-9_-]+)(?:\.(?<orgId>[A-Za-z0-9_-]+))?\.(?<secret>[A-Fa-f0-9]{32,128})$/;
    const match = tokenPattern.exec(refreshToken);
    if (!match?.groups?.tokenId || !match.groups.secret) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    return {
      tokenId: match.groups.tokenId,
      orgId: match.groups.orgId,
      secret: match.groups.secret
    };
  }

  async login(
    email: string,
    password: string,
    orgId?: string,
    ipAddress?: string,
    userAgent?: string
  ) {
    await this.validateRateLimit(`login:${ipAddress ?? email}`);
    const user = await this.validateUser(email, password, orgId);

    const { token: accessToken, expiresAt } = this.signAccessToken(user);
    const { token: refreshToken } = await this.signRefreshToken(user, ipAddress, userAgent);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: user.orgId,
          actorId: user.id,
          resource: "auth",
          action: "login",
          metadata: { email },
          ipAddress
        }
      },
      { orgId: user.orgId, actorId: user.id, resource: "auth", action: "login" }
    );

    const organizations = await this.orgService.listOrganizationOptionsForUser(user.id);
    return {
      user,
      accessToken,
      refreshToken,
      organizations,
      expiresIn: expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : 900
    };
  }

  async refresh(
    refreshToken: string,
    orgId?: string,
    ipAddress?: string,
    userAgent?: string
  ) {
    const { tokenId, orgId: tokenOrgId, secret } = this.parseRefreshToken(refreshToken);

    const effectiveOrgId = orgId ?? tokenOrgId;
    const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
    const cacheKey = effectiveOrgId
      ? `auth:refresh:${tokenId}:${effectiveOrgId}:${secretHash}`
      : `auth:refresh:${tokenId}:${secretHash}`;
    const graceSeconds = this.env.authRefreshGraceSeconds;
    const lockTtlMs = Math.max(graceSeconds * 1000, 10_000);

    return this.cache.wrap(
      cacheKey,
      graceSeconds,
      async () => {
        const now = new Date();
        const graceMs = graceSeconds * 1000;
        const record = await this.prisma.refreshToken.findUnique({
          where: { id: tokenId }
        });

        if (!record || record.expiresAt < now) {
          throw new UnauthorizedException("Refresh token expired");
        }

        if (record.revokedAt) {
          const revokedAgeMs = now.getTime() - record.revokedAt.getTime();
          if (revokedAgeMs > graceMs) {
            throw new UnauthorizedException("Refresh token expired");
          }
        }

        const matches = await bcrypt.compare(secret, record.tokenHash);
        if (!matches) {
          throw new UnauthorizedException("Invalid refresh token");
        }

        const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
        if (!user || !user.isActive) {
          throw new UnauthorizedException("User not found");
        }

        const memberships = await this.prisma.membership.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "asc" },
          include: {
            org: true,
            roles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: { permission: true }
                    }
                  }
                }
              }
            },
            role: {
              include: {
                permissions: {
                  include: { permission: true }
                }
              }
            }
          }
        });

        const primaryMembership = this.pickMembership(memberships, effectiveOrgId);
        if (!primaryMembership.org?.isActive) {
          throw new UnauthorizedException("Organization disabled");
        }

        const { roleIds, permissions } = this.buildMembershipClaims(primaryMembership);

        const authUser: AuthenticatedUser = {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          orgId: primaryMembership.orgId,
          roleIds,
          permissions
        };

        const { token: accessToken, expiresAt } = this.signAccessToken(authUser);
        const newRefreshToken = await this.signRefreshToken(authUser, ipAddress, userAgent);

        await this.prisma.refreshToken.updateMany({
          where: { id: tokenId, revokedAt: null },
          data: {
            revokedAt: now,
            ipAddress,
            userAgent
          }
        });

        const organizations = await this.orgService.listOrganizationOptionsForUser(user.id);
        return {
          user: authUser,
          accessToken,
          refreshToken: newRefreshToken.token,
          organizations,
          expiresIn: expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : 900
        };
      },
      {
        lockTtlMs,
        maxWaitMs: lockTtlMs,
        retryDelayMs: 50
      }
    );
  }

  async logout(
    userId: string,
    orgId?: string,
    refreshToken?: string,
    accessTokenId?: string,
    accessTokenExpiresAt?: number,
    logoutAll?: boolean
  ) {
    const now = new Date();

    if (logoutAll) {
      await this.prisma.refreshToken.updateMany({
        where: { userId },
        data: { revokedAt: now }
      });
    } else if (refreshToken) {
      const [tokenId] = refreshToken.split(".");
      if (tokenId) {
        await this.prisma.refreshToken.updateMany({
          where: { id: tokenId, userId },
          data: { revokedAt: now }
        });
      }
    }

    if (accessTokenId && accessTokenExpiresAt) {
      const ttlSeconds = Math.ceil((accessTokenExpiresAt - Date.now()) / 1000);
      if (ttlSeconds > 0) {
        await this.accessTokenBlacklist.add(accessTokenId, ttlSeconds);
      }
    }

    const membership = await this.prisma.membership.findFirst({
      where: { userId, ...(orgId ? { orgId } : {}) }
    });

    if (membership) {
      await writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId: membership.orgId,
            actorId: userId,
            resource: "auth",
            action: "logout"
          }
        },
        { orgId: membership.orgId, actorId: userId, resource: "auth", action: "logout" }
      );
    }
  }

  async getUserProfile(userId: string, orgId?: string) {
    const cacheKey = `profile:${userId}:${orgId ?? "default"}`;
    const settings = await this.authCacheSettings.getSettings();
    return this.cache.wrap(
      cacheKey,
      settings.profileTtlSeconds,
      async () => {
        const memberships = await this.prisma.membership.findMany({
          where: { userId },
          orderBy: { createdAt: "asc" },
          include: {
            org: true,
            roles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: { permission: true }
                    }
                  }
                }
              }
            },
            role: {
              include: {
                permissions: {
                  include: { permission: true }
                }
              }
            }
          }
        });

        const membership = this.pickMembership(memberships, orgId);
        if (!membership.org?.isActive) {
          throw new UnauthorizedException("Organization disabled");
        }

        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
          throw new UnauthorizedException("Invalid access token");
        }
        if (!user.isActive) {
          throw new UnauthorizedException("User disabled");
        }

        const { roleIds, permissions } = this.buildMembershipClaims(membership);

        return {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          orgId: membership.orgId,
          roleIds,
          permissions
        };
      },
      {
        lockTtlMs: settings.lockTtlMs,
        retryDelayMs: settings.retryDelayMs,
        maxWaitMs: settings.maxWaitMs
      }
    );
  }
}

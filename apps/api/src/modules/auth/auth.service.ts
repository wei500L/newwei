import { Injectable, UnauthorizedException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { EnvService } from "../config/config.service";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { CacheService } from "../cache/cache.service";
import { AccessTokenBlacklistService } from "./access-token-blacklist.service";
import { RateLimitConfigService } from "../system-settings/rate-limit-config.service";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { AuthCacheSettingsService } from "./auth-cache-settings.service";
import { OrgService } from "../org/org.service";

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

  private pickMembership<T extends { orgId: string }>(memberships: T[], orgId?: string): T {
    if (memberships.length === 0) {
      throw new UnauthorizedException("User is not assigned to an organization");
    }
    if (!orgId) {
      return memberships[0];
    }
    const membership = memberships.find((candidate) => candidate.orgId === orgId);
    if (!membership) {
      throw new UnauthorizedException("User is not assigned to the specified organization");
    }
    return membership;
  }

  async validateUser(email: string, password: string, orgId?: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          orderBy: { createdAt: "asc" },
          include: {
            org: true,
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

    const permissions = Array.from(
      new Set(
        primaryMembership.role.permissions.map((rp) => rp.permission.name)
      )
    );

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      orgId: primaryMembership.orgId,
      roleIds: [primaryMembership.roleId],
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
    const token = jwt.sign(payload, jwtConfig.secret, {
      expiresIn: jwtConfig.accessExpiresIn,
      audience: jwtConfig.audience,
      issuer: jwtConfig.issuer,
      jwtid: crypto.randomUUID()
    });
    const decoded = jwt.decode(token) as { exp?: number } | null;
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

    await this.prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        actorId: user.id,
        resource: "auth",
        action: "login",
        metadata: { email },
        ipAddress
      }
    });

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

    const record = await this.prisma.refreshToken.findUnique({
      where: { id: tokenId }
    });

    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token expired");
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
        role: {
          include: {
            permissions: {
              include: { permission: true }
            }
          }
        }
      }
    });

    const primaryMembership = this.pickMembership(memberships, orgId ?? tokenOrgId);
    if (!primaryMembership.org?.isActive) {
      throw new UnauthorizedException("Organization disabled");
    }

    const permissions = Array.from(
      new Set(primaryMembership.role.permissions.map((p) => p.permission.name))
    );

    const authUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      orgId: primaryMembership.orgId,
      roleIds: [primaryMembership.roleId],
      permissions
    };

    const { token: accessToken, expiresAt } = this.signAccessToken(authUser);
    const newRefreshToken = await this.signRefreshToken(authUser, ipAddress, userAgent);

    await this.prisma.refreshToken.update({
      where: { id: tokenId },
      data: {
        revokedAt: new Date(),
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
      await this.prisma.auditLog.create({
        data: {
          orgId: membership.orgId,
          actorId: userId,
          resource: "auth",
          action: "logout"
        }
      });
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

        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        if (!user.isActive) {
          throw new UnauthorizedException("User disabled");
        }

        const permissions = Array.from(
          new Set(membership.role.permissions.map((perm) => perm.permission.name))
        );

        return {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          orgId: membership.orgId,
          roleIds: [membership.roleId],
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

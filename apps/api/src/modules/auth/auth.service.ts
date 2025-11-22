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
    private readonly accessTokenBlacklist: AccessTokenBlacklistService
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

    return {
      user,
      accessToken,
      refreshToken,
      expiresIn: expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : 900
    };
  }

  async refresh(
    refreshToken: string,
    orgId?: string,
    ipAddress?: string,
    userAgent?: string
  ) {
    const parts = refreshToken.split(".");
    if (parts.length < 2 || parts.length > 3) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const [tokenId, possibleOrgId, possibleSecret] = parts;
    const secret = parts.length === 3 ? possibleSecret : possibleOrgId;
    const tokenOrgId = parts.length === 3 ? possibleOrgId : undefined;

    if (!tokenId || !secret) {
      throw new UnauthorizedException("Invalid refresh token");
    }

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
    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: {
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

    return {
      user: authUser,
      accessToken,
      refreshToken: newRefreshToken.token,
      expiresIn: expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : 900
    };
  }

  async logout(
    userId: string,
    orgId?: string,
    refreshToken?: string,
    accessTokenId?: string,
    accessTokenExpiresAt?: number
  ) {
    if (refreshToken) {
      const [tokenId] = refreshToken.split(".");
      if (tokenId) {
        await this.prisma.refreshToken.updateMany({
          where: { id: tokenId, userId },
          data: { revokedAt: new Date() }
        });
      }
    }

    await this.prisma.refreshToken.updateMany({
      where: { userId },
      data: { revokedAt: new Date() }
    });

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
    const cached = await this.cache.get<AuthenticatedUser>(cacheKey);
    if (cached) {
      return cached;
    }

    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: {
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

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const permissions = membership.role.permissions.map((perm) => perm.permission.name);
    const profile: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      orgId: membership.orgId,
      roleIds: [membership.roleId],
      permissions
    };

    await this.cache.set(cacheKey, profile, 60);
    return profile;
  }
}

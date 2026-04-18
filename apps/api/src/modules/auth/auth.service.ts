import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import { decode, sign } from "jsonwebtoken";
import crypto from "node:crypto";

import {
  collectMembershipPermissionSet,
  collectMembershipRoleIds,
  type MembershipRoleWithPermissions,
  type MembershipWithRoles,
} from "../../common/authz/membership-permissions";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";
import { OrgService } from "../org/org.service";
import { StorageService } from "../storage/storage.service";
import { RateLimitConfigService } from "../system-settings/rate-limit-config.service";

import { AccessTokenBlacklistService } from "./access-token-blacklist.service";
import { AuthCacheSettingsService } from "./auth-cache-settings.service";
import { AuthEmailCodeSettingsService } from "./auth-email-code-settings.service";
import { MfaService } from "./mfa.service";
import { PlatformAccessService } from "./platform-access.service";
import { UpdateProfileDto } from "./dto/profile.dto";
import { RefreshTokenBlacklistService } from "./refresh-token-blacklist.service";

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
  emailVerified?: string | null;
  lastLoginAt?: string | null;
  pendingEmail?: string | null;
  orgId: string;
  primaryRoleId?: string | null;
  roleIds: string[];
  permissions: string[];
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  isActive?: boolean;
  planTier?: string | null;
  subscriptionStatus?: string | null;
  globalRoles?: string[];
  mfaEnabled?: boolean;
  mfaRequired?: boolean;
  mfaEnrollmentRequired?: boolean;
  accessTokenId?: string;
  accessTokenExpiresAt?: number;
}

export interface AuthenticatedLoginResult {
  user: AuthenticatedUser;
  accessToken: string;
  refreshToken: string;
  organizations: {
    id: string;
    name?: string;
    slug?: string;
    isActive?: boolean;
  }[];
  expiresIn: number;
}

export interface MfaChallengeResult {
  user: AuthenticatedUser;
  organizations: {
    id: string;
    name?: string;
    slug?: string;
    isActive?: boolean;
  }[];
  mfaRequired: true;
  authChallengeId: string;
  challengeExpiresAt: string;
}

export interface MfaEnrollmentChallengeResult {
  user: AuthenticatedUser;
  organizations: {
    id: string;
    name?: string;
    slug?: string;
    isActive?: boolean;
  }[];
  mfaEnrollmentRequired: true;
  enrollmentChallengeId: string;
  challengeExpiresAt: string;
}

type MembershipRole = MembershipRoleWithPermissions;

interface MembershipRecord extends MembershipWithRoles<MembershipRole> {
  orgId: string;
  isActive?: boolean;
  org?: {
    isActive?: boolean;
    slug?: string;
    planTier?: string | null;
    subscriptionStatus?: string | null;
  } | null;
}

interface MembershipPickOptions {
  requireExplicitOrg?: boolean;
}

type EmailCodeScene = "bind" | "login";

interface EmailCodePayload {
  codeHash: string;
  email: string;
  userId?: string;
}

const EMAIL_CODE_LENGTH = 8;
const INVALID_EMAIL_CODE_MESSAGE = "Verification code is invalid or expired";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly rateLimiter: RateLimiterService,
    private readonly rateLimitConfig: RateLimitConfigService,
    private readonly cache: CacheService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly refreshTokenBlacklist: RefreshTokenBlacklistService,
    private readonly authCacheSettings: AuthCacheSettingsService,
    private readonly authEmailCodeSettings: AuthEmailCodeSettingsService,
    private readonly orgService: OrgService,
    private readonly storageService: StorageService,
    private readonly emailService: EmailService,
    private readonly platformAccess: PlatformAccessService,
    private readonly mfaService: MfaService,
  ) {}

  private async validateRateLimit(identifier: string) {
    const { limit, windowSeconds } =
      await this.rateLimitConfig.getBucketConfig("login");
    const allowed = await this.rateLimiter.consume(
      identifier,
      limit,
      windowSeconds,
    );
    if (!allowed) {
      throw new TooManyRequestsException(
        "Too many login attempts. Please try again later.",
      );
    }
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private normalizeCode(code: string) {
    return code.trim();
  }

  private formatEmailVerified(value: Date | null | undefined) {
    return value ? value.toISOString() : null;
  }

  private buildEmailCodeKey(scene: EmailCodeScene, identifier: string) {
    return `auth:email-code:${scene}:${identifier}`;
  }

  private buildEmailCodeAttemptsKey(scene: EmailCodeScene, identifier: string) {
    return `auth:email-code:attempts:${scene}:${identifier}`;
  }

  private buildEmailCodeCooldownKey(scene: EmailCodeScene, identifier: string) {
    return `auth:email-code:cooldown:${scene}:${identifier}`;
  }

  private hashEmailCode(code: string) {
    return crypto.createHash("sha256").update(code).digest("hex");
  }

  private generateEmailCode(length = EMAIL_CODE_LENGTH) {
    let code = "";
    for (let i = 0; i < length; i += 1) {
      code += crypto.randomInt(0, 10).toString();
    }
    return code;
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }

  private async clearEmailCodeState(scene: EmailCodeScene, identifier: string) {
    await this.cache.del(this.buildEmailCodeKey(scene, identifier));
    await this.cache.del(this.buildEmailCodeAttemptsKey(scene, identifier));
  }

  private async markEmailCodeAttemptFailed(
    scene: EmailCodeScene,
    identifier: string,
  ) {
    const { ttlSeconds, maxAttempts } =
      await this.authEmailCodeSettings.getSettings();
    const attempts = await this.cache.incr(
      this.buildEmailCodeAttemptsKey(scene, identifier),
      ttlSeconds,
    );
    if (attempts >= maxAttempts) {
      await this.clearEmailCodeState(scene, identifier);
    }
    return attempts;
  }

  private async reserveEmailCodeCooldown(
    scene: EmailCodeScene,
    identifier: string,
  ) {
    const { cooldownSeconds } = await this.authEmailCodeSettings.getSettings();
    const accepted = await this.cache.setIfAbsent(
      this.buildEmailCodeCooldownKey(scene, identifier),
      { createdAt: Date.now() },
      cooldownSeconds,
    );
    return { accepted, cooldownSeconds };
  }

  private async invalidateProfileCache(userId: string, orgId?: string) {
    await this.cache.del(`profile:${userId}:${orgId ?? "default"}`);

    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { orgId: true },
    });
    for (const membership of memberships) {
      await this.cache.del(`profile:${userId}:${membership.orgId}`);
    }
  }

  private isMembershipAccessible(membership: {
    isActive?: boolean;
    org?: { isActive?: boolean } | null;
  }): boolean {
    return (membership.org?.isActive ?? true) && (membership.isActive ?? true);
  }

  private assertMembershipAccessible(membership: {
    isActive?: boolean;
    org?: { isActive?: boolean } | null;
  }) {
    if (!(membership.org?.isActive ?? true)) {
      throw new UnauthorizedException("Organization disabled");
    }
    if (!(membership.isActive ?? true)) {
      throw new UnauthorizedException("Organization access disabled");
    }
  }

  private pickMembership<
    T extends {
      orgId: string;
      isActive?: boolean;
      org?: { isActive: boolean; slug?: string } | null;
    },
  >(
    memberships: T[],
    orgIdOrSlug?: string,
    options?: MembershipPickOptions,
  ): T {
    if (memberships.length === 0) {
      throw new UnauthorizedException(
        "User is not assigned to an organization",
      );
    }
    if (!orgIdOrSlug) {
      const activeMemberships = memberships.filter((membership) =>
        this.isMembershipAccessible(membership),
      );

      if (memberships.length === 1) {
        if (activeMemberships.length === 1) {
          return activeMemberships[0]!;
        }
        this.assertMembershipAccessible(memberships[0]!);
      }

      if (activeMemberships.length === 1) {
        return activeMemberships[0]!;
      }

      if (activeMemberships.length === 0) {
        if (memberships.some((membership) => !(membership.isActive ?? true))) {
          throw new UnauthorizedException("Organization access disabled");
        }
        throw new UnauthorizedException("Organization disabled");
      }

      if (options?.requireExplicitOrg === false) {
        return activeMemberships[0]!;
      }

      throw new BadRequestException(
        "Organization is required when a user belongs to multiple organizations",
      );
    }
    const normalized = orgIdOrSlug.trim();
    const normalizedLower = normalized.toLowerCase();

    const membership = memberships.find((candidate) => {
      if (
        candidate.orgId === normalized ||
        candidate.orgId.toLowerCase() === normalizedLower
      ) {
        return true;
      }
      const slug = candidate.org?.slug;
      if (typeof slug === "string" && slug.toLowerCase() === normalizedLower) {
        return true;
      }
      return false;
    });
    if (!membership) {
      throw new UnauthorizedException(
        "User is not assigned to the specified organization",
      );
    }
    return membership;
  }

  private buildMembershipClaims(
    membership: MembershipRecord,
  ): Pick<
    AuthenticatedUser,
    | "primaryRoleId"
    | "roleIds"
    | "permissions"
    | "planTier"
    | "subscriptionStatus"
  > {
    return {
      primaryRoleId: membership.roleId ?? null,
      roleIds: collectMembershipRoleIds(membership),
      permissions: Array.from(collectMembershipPermissionSet(membership)),
      planTier: membership.org?.planTier ?? null,
      subscriptionStatus: membership.org?.subscriptionStatus ?? null,
    };
  }

  private async buildAuthenticatedUser(
    user: {
      id: string;
      email: string;
      emailVerified?: Date | null;
      lastLoginAt?: Date | null;
      pendingEmail?: string | null;
      firstName: string;
      lastName: string;
      avatarUrl?: string | null;
      isActive?: boolean;
    },
    membership: MembershipRecord,
  ): Promise<AuthenticatedUser> {
    const {
      primaryRoleId,
      roleIds,
      permissions,
      planTier,
      subscriptionStatus,
    } = this.buildMembershipClaims(membership);
    const [globalRoles, mfaStatus] = await Promise.all([
      this.platformAccess.getGlobalRoles(user.id),
      this.mfaService.getStatus(user.id),
    ]);

    return {
      id: user.id,
      email: user.email,
      emailVerified: this.formatEmailVerified(user.emailVerified),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      pendingEmail: user.pendingEmail ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl ?? null,
      isActive: (user.isActive ?? true) && (membership.isActive ?? true),
      orgId: membership.orgId,
      primaryRoleId,
      roleIds,
      permissions,
      planTier,
      subscriptionStatus,
      globalRoles,
      mfaEnabled: mfaStatus.enabled,
      mfaRequired: false,
      mfaEnrollmentRequired: false,
    };
  }

  private async finalizeLogin(
    authUser: AuthenticatedUser,
    ipAddress?: string,
    userAgent?: string,
    action = "login",
  ): Promise<AuthenticatedLoginResult> {
    const { token: accessToken, expiresAt } = this.signAccessToken(authUser);
    const { token: refreshToken } = await this.signRefreshToken(
      authUser,
      ipAddress,
      userAgent,
    );

    await this.prisma.user.update({
      where: { id: authUser.id },
      data: { lastLoginAt: new Date() },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: authUser.orgId,
          actorId: authUser.id,
          resource: "auth",
          action,
          metadata: { email: authUser.email, userAgent: userAgent ?? null },
          ipAddress,
        },
      },
      {
        orgId: authUser.orgId,
        actorId: authUser.id,
        resource: "auth",
        action,
      },
    );

    const organizations = await this.orgService.listOrganizationOptionsForUser(
      authUser.id,
    );
    return {
      user: authUser,
      accessToken,
      refreshToken,
      organizations,
      expiresIn: expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : 900,
    };
  }

  private async completeTrustedLogin(
    userId: string,
    orgId: string,
    ipAddress?: string,
    userAgent?: string,
    action = "login",
    options?: { skipMfa?: boolean },
  ): Promise<
    AuthenticatedLoginResult | MfaChallengeResult | MfaEnrollmentChallengeResult
  > {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
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
                      include: { permission: true },
                    },
                  },
                },
              },
            },
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const membership = this.pickMembership(user.memberships, orgId, {
      requireExplicitOrg: false,
    });
    this.assertMembershipAccessible(membership);

    const authUser = await this.buildAuthenticatedUser(user, membership);
    if (!options?.skipMfa) {
      const loginRequirement = await this.mfaService.getLoginRequirement(
        user.id,
        membership.orgId,
      );
      if (loginRequirement !== "none") {
        const organizations =
          await this.orgService.listOrganizationOptionsForUser(user.id);

        if (loginRequirement === "verify") {
          const challenge = await this.mfaService.createLoginChallenge({
            userId: user.id,
            orgId: membership.orgId,
            ipAddress,
            userAgent,
          });
          return {
            user: { ...authUser, mfaRequired: true },
            organizations,
            mfaRequired: true,
            authChallengeId: challenge.challengeId,
            challengeExpiresAt: challenge.expiresAt,
          };
        }

        const challenge = await this.mfaService.createEnrollmentChallenge({
          userId: user.id,
          orgId: membership.orgId,
          ipAddress,
          userAgent,
          action,
        });
        return {
          user: { ...authUser, mfaEnrollmentRequired: true },
          organizations,
          mfaEnrollmentRequired: true,
          enrollmentChallengeId: challenge.challengeId,
          challengeExpiresAt: challenge.expiresAt,
        };
      }
    }

    return this.finalizeLogin(authUser, ipAddress, userAgent, action);
  }

  async validateUser(
    email: string,
    password: string,
    orgId?: string,
  ): Promise<AuthenticatedUser> {
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
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
                        permission: true,
                      },
                    },
                  },
                },
              },
            },
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const primaryMembership = this.pickMembership(user.memberships, orgId, {
      requireExplicitOrg: false,
    });
    this.assertMembershipAccessible(primaryMembership);

    return this.buildAuthenticatedUser(user, primaryMembership);
  }

  private signAccessToken(user: AuthenticatedUser) {
    const jwtConfig = this.env.jwtConfig;
    const payload: JwtPayload = {
      sub: user.id,
      orgId: user.orgId,
      permissions: user.permissions,
    };
    const expiresInSeconds = Math.max(
      1,
      Math.floor(this.parseTimespan(jwtConfig.accessExpiresIn) / 1000),
    );
    const token = sign(payload, jwtConfig.secret, {
      expiresIn: expiresInSeconds,
      audience: jwtConfig.audience,
      issuer: jwtConfig.issuer,
      jwtid: crypto.randomUUID(),
    });
    const decoded = decode(token) as { exp?: number } | null;
    const expiresIn = decoded?.exp ? decoded.exp * 1000 : undefined;
    return { token, expiresAt: expiresIn };
  }

  private async signRefreshToken(
    user: AuthenticatedUser,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const jwtConfig = this.env.jwtConfig;
    const secret = crypto.randomBytes(32).toString("hex");
    const tokenId = crypto.randomUUID();

    const tokenHash = await bcrypt.hash(secret, 10);
    const expiresAt = new Date(
      Date.now() + this.parseTimespan(jwtConfig.refreshExpiresIn),
    );

    await this.prisma.refreshToken.create({
      data: {
        id: tokenId,
        userId: user.id,
        tokenHash,
        expiresAt,
        ipAddress,
        userAgent,
      },
    });

    return {
      token: user.orgId
        ? `${tokenId}.${user.orgId}.${secret}`
        : `${tokenId}.${secret}`,
      expiresAt,
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

  private ttlSecondsUntil(expiresAt: Date, now: Date) {
    const remainingMs = expiresAt.getTime() - now.getTime();
    if (!Number.isFinite(remainingMs)) {
      return 0;
    }
    return Math.max(0, Math.ceil(remainingMs / 1000));
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
      secret: match.groups.secret,
    };
  }

  async login(
    email: string,
    password: string,
    orgId?: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const normalizedEmail = this.normalizeEmail(email);
    await this.validateRateLimit(`login:${ipAddress ?? normalizedEmail}`);
    const user = await this.validateUser(normalizedEmail, password, orgId);
    return this.completeTrustedLogin(
      user.id,
      user.orgId,
      ipAddress,
      userAgent,
      "login",
    );
  }

  async sendVerificationCode(
    userId: string,
    orgId: string,
    email: string,
    ipAddress?: string,
  ) {
    const normalizedEmail = this.normalizeEmail(email);
    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        isActive: true,
      },
    });

    if (!currentUser || !currentUser.isActive) {
      throw new UnauthorizedException("Invalid access token");
    }

    if (normalizedEmail === this.normalizeEmail(currentUser.email)) {
      throw new BadRequestException(
        "New email must be different from current email",
      );
    }

    const existsByEmail = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existsByEmail && existsByEmail.id !== userId) {
      throw new BadRequestException("Email is already in use");
    }

    const pendingConflict = await this.prisma.user.findFirst({
      where: {
        pendingEmail: normalizedEmail,
        NOT: { id: userId },
      },
      select: { id: true },
    });
    if (pendingConflict) {
      throw new BadRequestException("Email is already pending verification");
    }

    const { accepted, cooldownSeconds } = await this.reserveEmailCodeCooldown(
      "bind",
      userId,
    );
    if (!accepted) {
      throw new TooManyRequestsException(
        "Please wait before requesting another code",
      );
    }

    const { ttlSeconds } = await this.authEmailCodeSettings.getSettings();
    const expiresMinutes = Math.max(1, Math.ceil(ttlSeconds / 60));
    const code = this.generateEmailCode();
    const codeKey = this.buildEmailCodeKey("bind", userId);
    const attemptsKey = this.buildEmailCodeAttemptsKey("bind", userId);
    const cooldownKey = this.buildEmailCodeCooldownKey("bind", userId);

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { pendingEmail: normalizedEmail },
      });

      await this.cache.set<EmailCodePayload>(
        codeKey,
        {
          codeHash: this.hashEmailCode(code),
          email: normalizedEmail,
          userId,
        },
        ttlSeconds,
      );
      await this.cache.del(attemptsKey);

      const html = this.emailService.buildVerificationCodeTemplate({
        scene: "bind",
        code,
        expiresMinutes,
      });
      const text = this.emailService.buildVerificationCodeTextTemplate({
        scene: "bind",
        code,
        expiresMinutes,
      });

      await this.emailService.send({
        to: normalizedEmail,
        subject: "邮箱绑定验证码",
        html,
        text,
      });
    } catch (error) {
      await this.clearEmailCodeState("bind", userId);
      await this.cache.del(cooldownKey);
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException("Email is already in use");
      }
      throw error;
    }

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "auth",
          action: "send_verification_code",
          metadata: { pendingEmail: normalizedEmail },
          ipAddress,
        },
      },
      {
        orgId,
        actorId: userId,
        resource: "auth",
        action: "send_verification_code",
      },
    );

    return { ok: true as const, cooldownSeconds };
  }

  async verifyEmail(
    userId: string,
    orgId: string,
    code: string,
    ipAddress?: string,
  ) {
    const codeValue = this.normalizeCode(code);
    const identifier = userId;
    const payload = await this.cache.get<EmailCodePayload>(
      this.buildEmailCodeKey("bind", identifier),
    );

    if (!payload) {
      throw new BadRequestException(INVALID_EMAIL_CODE_MESSAGE);
    }

    const inputHash = this.hashEmailCode(codeValue);
    if (payload.codeHash !== inputHash) {
      await this.markEmailCodeAttemptFailed("bind", identifier);
      throw new BadRequestException(INVALID_EMAIL_CODE_MESSAGE);
    }

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          email: payload.email,
          emailVerified: new Date(),
          pendingEmail: null,
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException("Email is already in use");
      }
      throw error;
    }

    await this.clearEmailCodeState("bind", identifier);
    await this.cache.del(this.buildEmailCodeCooldownKey("bind", identifier));
    await this.invalidateProfileCache(userId, orgId);

    const profile = await this.getUserProfile(userId, orgId);
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "auth",
          action: "verify_email",
          metadata: { email: payload.email },
          ipAddress,
        },
      },
      { orgId, actorId: userId, resource: "auth", action: "verify_email" },
    );

    return profile;
  }

  async sendLoginCode(email: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const { accepted, cooldownSeconds } = await this.reserveEmailCodeCooldown(
      "login",
      normalizedEmail,
    );

    if (!accepted) {
      return { ok: true as const, cooldownSeconds };
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        isActive: true,
        emailVerified: true,
      },
    });

    if (!user || !user.isActive || !user.emailVerified) {
      return { ok: true as const, cooldownSeconds };
    }

    const { ttlSeconds } = await this.authEmailCodeSettings.getSettings();
    const expiresMinutes = Math.max(1, Math.ceil(ttlSeconds / 60));
    const code = this.generateEmailCode();
    const codeKey = this.buildEmailCodeKey("login", normalizedEmail);
    const attemptsKey = this.buildEmailCodeAttemptsKey(
      "login",
      normalizedEmail,
    );
    const cooldownKey = this.buildEmailCodeCooldownKey(
      "login",
      normalizedEmail,
    );

    try {
      await this.cache.set<EmailCodePayload>(
        codeKey,
        {
          codeHash: this.hashEmailCode(code),
          email: normalizedEmail,
          userId: user.id,
        },
        ttlSeconds,
      );
      await this.cache.del(attemptsKey);

      const html = this.emailService.buildVerificationCodeTemplate({
        scene: "login",
        code,
        expiresMinutes,
      });
      const text = this.emailService.buildVerificationCodeTextTemplate({
        scene: "login",
        code,
        expiresMinutes,
      });

      await this.emailService.send({
        to: normalizedEmail,
        subject: "登录验证码",
        html,
        text,
      });
    } catch {
      await this.clearEmailCodeState("login", normalizedEmail);
      await this.cache.del(cooldownKey);
    }

    return { ok: true as const, cooldownSeconds };
  }

  async loginWithCode(
    email: string,
    code: string,
    orgId?: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const normalizedEmail = this.normalizeEmail(email);
    await this.validateRateLimit(`login-code:${ipAddress ?? normalizedEmail}`);

    const codeValue = this.normalizeCode(code);
    const payload = await this.cache.get<EmailCodePayload>(
      this.buildEmailCodeKey("login", normalizedEmail),
    );
    if (!payload || payload.email !== normalizedEmail) {
      throw new UnauthorizedException(INVALID_EMAIL_CODE_MESSAGE);
    }

    if (payload.codeHash !== this.hashEmailCode(codeValue)) {
      await this.markEmailCodeAttemptFailed("login", normalizedEmail);
      throw new UnauthorizedException(INVALID_EMAIL_CODE_MESSAGE);
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
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
                        permission: true,
                      },
                    },
                  },
                },
              },
            },
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user || !user.isActive || !user.emailVerified) {
      await this.markEmailCodeAttemptFailed("login", normalizedEmail);
      throw new UnauthorizedException(INVALID_EMAIL_CODE_MESSAGE);
    }
    if (payload.userId && payload.userId !== user.id) {
      await this.markEmailCodeAttemptFailed("login", normalizedEmail);
      throw new UnauthorizedException(INVALID_EMAIL_CODE_MESSAGE);
    }

    const primaryMembership = this.pickMembership(user.memberships, orgId, {
      requireExplicitOrg: false,
    });
    this.assertMembershipAccessible(primaryMembership);

    await this.clearEmailCodeState("login", normalizedEmail);
    await this.cache.del(
      this.buildEmailCodeCooldownKey("login", normalizedEmail),
    );
    return this.completeTrustedLogin(
      user.id,
      primaryMembership.orgId,
      ipAddress,
      userAgent,
      "login_with_code",
    );
  }

  async refresh(
    refreshToken: string,
    orgId?: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const {
      tokenId,
      orgId: tokenOrgId,
      secret,
    } = this.parseRefreshToken(refreshToken);

    const effectiveOrgId = orgId ?? tokenOrgId;
    const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
    const cacheKey = `auth:refresh:${tokenId}:${secretHash}`;
    const graceSeconds = this.env.authRefreshGraceSeconds;
    const lockTtlMs = Math.max(graceSeconds * 1000, 10_000);

    return this.cache.wrap(
      cacheKey,
      graceSeconds,
      async () => {
        const now = new Date();
        const isBlacklisted = await this.refreshTokenBlacklist.has(tokenId);
        if (isBlacklisted) {
          throw new UnauthorizedException("Refresh token expired");
        }
        const record = await this.prisma.refreshToken.findUnique({
          where: { id: tokenId },
        });

        if (!record || record.expiresAt < now) {
          throw new UnauthorizedException("Refresh token expired");
        }

        if (record.revokedAt) {
          throw new UnauthorizedException("Refresh token expired");
        }

        const matches = await bcrypt.compare(secret, record.tokenHash);
        if (!matches) {
          throw new UnauthorizedException("Invalid refresh token");
        }

        const user = await this.prisma.user.findUnique({
          where: { id: record.userId },
        });
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
                      include: { permission: true },
                    },
                  },
                },
              },
            },
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        });

        const primaryMembership = this.pickMembership(
          memberships,
          effectiveOrgId,
        );
        this.assertMembershipAccessible(primaryMembership);

        const authUser = await this.buildAuthenticatedUser(
          user,
          primaryMembership,
        );

        const { token: accessToken, expiresAt } =
          this.signAccessToken(authUser);
        const newRefreshToken = await this.signRefreshToken(
          authUser,
          ipAddress,
          userAgent,
        );

        await this.prisma.refreshToken.updateMany({
          where: { id: tokenId, revokedAt: null },
          data: {
            revokedAt: now,
            ipAddress,
            userAgent,
          },
        });

        const blacklistTtlSeconds = this.ttlSecondsUntil(record.expiresAt, now);
        if (blacklistTtlSeconds > 0) {
          await this.refreshTokenBlacklist.add(tokenId, blacklistTtlSeconds);
        }

        const organizations =
          await this.orgService.listOrganizationOptionsForUser(user.id);
        return {
          user: authUser,
          accessToken,
          refreshToken: newRefreshToken.token,
          organizations,
          expiresIn: expiresAt
            ? Math.floor((expiresAt - Date.now()) / 1000)
            : 900,
        };
      },
      {
        lockTtlMs,
        maxWaitMs: lockTtlMs,
        retryDelayMs: 50,
      },
    );
  }

  async logout(
    userId: string,
    orgId?: string,
    refreshToken?: string,
    accessTokenId?: string,
    accessTokenExpiresAt?: number,
    logoutAll?: boolean,
  ) {
    const now = new Date();

    if (logoutAll) {
      await this.prisma.refreshToken.updateMany({
        where: { userId },
        data: { revokedAt: now },
      });
    } else if (refreshToken) {
      const [tokenId] = refreshToken.split(".");
      if (tokenId) {
        await this.prisma.refreshToken.updateMany({
          where: { id: tokenId, userId },
          data: { revokedAt: now },
        });

        const record = await this.prisma.refreshToken.findUnique({
          where: { id: tokenId },
        });
        if (record && record.userId === userId) {
          const blacklistTtlSeconds = this.ttlSecondsUntil(
            record.expiresAt,
            now,
          );
          if (blacklistTtlSeconds > 0) {
            await this.refreshTokenBlacklist.add(tokenId, blacklistTtlSeconds);
          }
        }
      }
    }

    if (accessTokenId && accessTokenExpiresAt) {
      const ttlSeconds = Math.ceil((accessTokenExpiresAt - Date.now()) / 1000);
      if (ttlSeconds > 0) {
        await this.accessTokenBlacklist.add(accessTokenId, ttlSeconds);
      }
    }

    const membership = await this.prisma.membership.findFirst({
      where: { userId, ...(orgId ? { orgId } : {}) },
    });

    if (membership) {
      await writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId: membership.orgId,
            actorId: userId,
            resource: "auth",
            action: "logout",
          },
        },
        {
          orgId: membership.orgId,
          actorId: userId,
          resource: "auth",
          action: "logout",
        },
      );
    }
  }

  async updateProfile(
    userId: string,
    orgId: string | undefined,
    input: UpdateProfileDto,
  ) {
    const updates: {
      firstName?: string;
      lastName?: string;
      avatarUrl?: string | null;
    } = {};

    if (input.firstName !== undefined) {
      const trimmed = input.firstName.trim();
      if (!trimmed) {
        throw new BadRequestException("First name cannot be empty");
      }
      updates.firstName = trimmed;
    }

    if (input.lastName !== undefined) {
      const trimmed = input.lastName.trim();
      if (!trimmed) {
        throw new BadRequestException("Last name cannot be empty");
      }
      updates.lastName = trimmed;
    }

    if (input.avatarUrl !== undefined) {
      const trimmed = input.avatarUrl.trim();
      if (!trimmed) {
        throw new BadRequestException("Avatar URL cannot be empty");
      }
      if (!(await this.storageService.isPublicUrl(trimmed))) {
        throw new BadRequestException(
          "Avatar URL must use the approved storage base URL",
        );
      }
      updates.avatarUrl = trimmed;
    }

    if (Object.keys(updates).length === 0) {
      return this.getUserProfile(userId, orgId);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: updates,
    });

    await this.invalidateProfileCache(userId, orgId);
    return this.getUserProfile(userId, orgId);
  }

  async changePassword(
    userId: string,
    orgId: string | undefined,
    currentPassword: string,
    newPassword: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException("Password fields are required");
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        "New password must be different from current password",
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        passwordHash: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const passwordValid = await bcrypt.compare(
      currentPassword,
      user.passwordHash,
    );
    if (!passwordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    await this.invalidateProfileCache(userId, orgId);
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
                      include: { permission: true },
                    },
                  },
                },
              },
            },
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        });

        const membership = this.pickMembership(memberships, orgId);
        this.assertMembershipAccessible(membership);

        const user = await this.prisma.user.findUnique({
          where: { id: userId },
        });
        if (!user) {
          throw new UnauthorizedException("Invalid access token");
        }
        if (!user.isActive) {
          throw new UnauthorizedException("User disabled");
        }

        return this.buildAuthenticatedUser(user, membership);
      },
      {
        lockTtlMs: settings.lockTtlMs,
        retryDelayMs: settings.retryDelayMs,
        maxWaitMs: settings.maxWaitMs,
      },
    );
  }

  async beginTrustedLogin(
    userId: string,
    orgId: string,
    ipAddress?: string,
    userAgent?: string,
    action = "login",
  ) {
    return this.completeTrustedLogin(
      userId,
      orgId,
      ipAddress,
      userAgent,
      action,
    );
  }

  async completeMfaLogin(
    challengeId: string,
    code: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const challenge = await this.mfaService.consumeLoginChallenge(
      challengeId,
      code,
    );
    return this.completeTrustedLogin(
      challenge.userId,
      challenge.orgId,
      ipAddress ?? challenge.ipAddress ?? undefined,
      userAgent ?? challenge.userAgent ?? undefined,
      challenge.action === "login_with_oidc"
        ? "login_with_oidc"
        : "login_with_mfa",
      { skipMfa: true },
    );
  }

  async completeMfaEnrollmentLogin(
    challengeId: string,
    code: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const challenge = await this.mfaService.consumeEnrollmentChallenge(
      challengeId,
      code,
    );
    const result = await this.completeTrustedLogin(
      challenge.userId,
      challenge.orgId,
      ipAddress ?? challenge.ipAddress ?? undefined,
      userAgent ?? challenge.userAgent ?? undefined,
      challenge.action,
      { skipMfa: true },
    );
    if (!("accessToken" in result)) {
      throw new UnauthorizedException("MFA enrollment could not be completed");
    }
    return {
      ...result,
      recoveryCodes: challenge.recoveryCodes,
    };
  }
}

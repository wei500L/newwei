import {
  BadRequestException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashOpaqueToken,
  verifyTotpCode,
} from "./auth-flow.utils";
import { AuthSecurityService } from "./auth-security.service";

interface LoginChallengePayload {
  orgId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  action?: string | null;
}

const MFA_CHALLENGE_TTL_MINUTES = 10;
const MFA_ENROLLMENT_CHALLENGE_TTL_MINUTES = 15;
const MFA_ISSUER = "Modular";
const MFA_CODE_FAILURE_MESSAGE = "Invalid MFA verification code";
const MFA_CHALLENGE_LOCKED_MESSAGE =
  "Too many MFA verification attempts. Please sign in again.";

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSecurity: AuthSecurityService,
    private readonly env: EnvService,
  ) {}

  async getStatus(userId: string) {
    const factor = await this.prisma.userTotpFactor.findUnique({
      where: { userId },
    });
    const recoveryCodesRemaining = await this.prisma.userRecoveryCode.count({
      where: {
        userId,
        usedAt: null,
      },
    });

    return {
      enabled: Boolean(factor?.verifiedAt && !factor?.disabledAt),
      enrolledAt: factor?.enrolledAt ?? null,
      verifiedAt: factor?.verifiedAt ?? null,
      lastUsedAt: factor?.lastUsedAt ?? null,
      recoveryCodesRemaining,
    };
  }

  async beginEnrollment(userId: string, accountName: string) {
    const secret = generateTotpSecret();
    const storedSecret = await this.authSecurity.encodeSecret(secret);
    const existingFactor = await this.prisma.userTotpFactor.findUnique({
      where: { userId },
      select: {
        verifiedAt: true,
        disabledAt: true,
      },
    });

    if (existingFactor?.verifiedAt && !existingFactor.disabledAt) {
      await this.prisma.userTotpFactor.update({
        where: { userId },
        data: {
          pendingSecret: storedSecret as Prisma.InputJsonValue,
          pendingLabel: accountName,
          pendingStartedAt: new Date(),
        },
      });
    } else {
      await this.prisma.userTotpFactor.upsert({
        where: { userId },
        update: {
          secret: storedSecret as Prisma.InputJsonValue,
          pendingSecret: Prisma.DbNull,
          label: accountName,
          pendingLabel: null,
          pendingStartedAt: null,
          verifiedAt: null,
          disabledAt: null,
          lastUsedAt: null,
        },
        create: {
          userId,
          secret: storedSecret as Prisma.InputJsonValue,
          label: accountName,
        },
      });
    }

    return {
      secret,
      otpauthUri: buildOtpAuthUri({
        issuer: MFA_ISSUER,
        accountName,
        secret,
      }),
    };
  }

  async verifyEnrollment(userId: string, code: string) {
    const factor = await this.prisma.userTotpFactor.findUnique({
      where: { userId },
    });
    if (!factor) {
      throw new BadRequestException("MFA enrollment is not initialized");
    }

    const enrollmentSecretValue = factor.pendingSecret ?? factor.secret;
    const secret = await this.authSecurity.decodeSecret(enrollmentSecretValue);
    if (!secret || !verifyTotpCode(secret, code)) {
      throw new BadRequestException("Invalid MFA verification code");
    }

    const recoveryCodes = generateRecoveryCodes();
    const verifiedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.userTotpFactor.update({
        where: { userId },
        data: {
          secret: enrollmentSecretValue as Prisma.InputJsonValue,
          label: factor.pendingLabel ?? factor.label,
          pendingSecret: Prisma.DbNull,
          pendingLabel: null,
          pendingStartedAt: null,
          enrolledAt:
            factor.pendingSecret && factor.verifiedAt && !factor.disabledAt
              ? verifiedAt
              : factor.enrolledAt,
          verifiedAt,
          disabledAt: null,
          lastUsedAt: verifiedAt,
        },
      });
      await tx.userRecoveryCode.deleteMany({
        where: { userId },
      });
      await tx.userRecoveryCode.createMany({
        data: recoveryCodes.map((rawCode) => ({
          userId,
          codeHash: hashOpaqueToken(rawCode),
        })),
      });
    });

    return {
      recoveryCodes,
      ...(await this.getStatus(userId)),
    };
  }

  async disable(userId: string, code: string) {
    await this.verifyFactorOrRecoveryCode(userId, code);
    await this.prisma.$transaction(async (tx) => {
      await tx.userTotpFactor.updateMany({
        where: { userId },
        data: {
          disabledAt: new Date(),
        },
      });
      await tx.userRecoveryCode.deleteMany({
        where: { userId },
      });
    });
    return this.getStatus(userId);
  }

  async rotateRecoveryCodes(userId: string, code: string) {
    await this.verifyFactorOrRecoveryCode(userId, code);
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.userRecoveryCode.deleteMany({
        where: { userId },
      });
      await tx.userRecoveryCode.createMany({
        data: recoveryCodes.map((rawCode) => ({
          userId,
          codeHash: hashOpaqueToken(rawCode),
        })),
      });
    });

    return {
      recoveryCodes,
      ...(await this.getStatus(userId)),
    };
  }

  async getLoginRequirement(userId: string, orgId: string) {
    const factor = await this.prisma.userTotpFactor.findUnique({
      where: { userId },
      select: {
        verifiedAt: true,
        disabledAt: true,
      },
    });
    const enabled = Boolean(factor?.verifiedAt && !factor?.disabledAt);
    const policy = await this.authSecurity.getMfaPolicy();

    if (policy === "off") {
      return enabled ? "verify" : "none";
    }

    const isAdmin = await this.isOrgAdmin(userId, orgId);
    const applies =
      policy === "all_users" || (policy === "admins_only" && isAdmin);
    if (!applies) {
      return enabled ? "verify" : "none";
    }
    return enabled ? "verify" : "enroll";
  }

  async shouldRequireMfa(userId: string, orgId: string) {
    return (await this.getLoginRequirement(userId, orgId)) === "verify";
  }

  async createLoginChallenge(params: {
    userId: string;
    orgId: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const challenge = await this.prisma.authChallenge.create({
      data: {
        type: "mfa_login",
        userId: params.userId,
        orgId: params.orgId,
        payload: {
          orgId: params.orgId,
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
        } satisfies Prisma.InputJsonObject,
        expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MINUTES * 60_000),
      },
    });

    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  async createEnrollmentChallenge(params: {
    userId: string;
    orgId: string;
    ipAddress?: string;
    userAgent?: string;
    action?: string;
  }) {
    const challenge = await this.prisma.authChallenge.create({
      data: {
        type: "mfa_enrollment",
        userId: params.userId,
        orgId: params.orgId,
        payload: {
          orgId: params.orgId,
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
          action: params.action ?? "login",
        } satisfies Prisma.InputJsonObject,
        expiresAt: new Date(
          Date.now() + MFA_ENROLLMENT_CHALLENGE_TTL_MINUTES * 60_000,
        ),
      },
    });

    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  async beginEnrollmentWithChallenge(
    challengeId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const challenge = await this.getActiveChallenge(
      challengeId,
      "mfa_enrollment",
      "MFA enrollment challenge is invalid or expired",
    );
    if (!challenge.userId) {
      throw new UnauthorizedException(
        "MFA enrollment challenge is invalid or expired",
      );
    }

    // The enrollment challenge id travels through URL redirects (browser
    // history, referrers, logs). Bind it to the party that initiated the
    // flow so a third party holding only the id cannot enroll their own TOTP
    // device and take over the account.
    this.assertChallengeRequesterMatches(challenge, ipAddress, userAgent);

    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      select: {
        email: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException(
        "MFA enrollment challenge is invalid or expired",
      );
    }

    return this.beginEnrollment(challenge.userId, user.email);
  }

  async consumeLoginChallenge(challengeId: string, code: string) {
    const invalidChallengeMessage = "MFA challenge is invalid or expired";
    const challenge = await this.getActiveChallenge(
      challengeId,
      "mfa_login",
      invalidChallengeMessage,
    );
    if (!challenge.userId) {
      throw new UnauthorizedException(invalidChallengeMessage);
    }

    try {
      await this.verifyFactorOrRecoveryCode(challenge.userId, code);
    } catch (error) {
      return this.recordChallengeFailure(
        challenge.id,
        invalidChallengeMessage,
        error,
      );
    }

    await this.consumeChallengeOrThrow(challenge.id, invalidChallengeMessage);

    const payload = this.parseLoginChallengePayload(challenge.payload);
    return {
      userId: challenge.userId,
      orgId: payload.orgId ?? challenge.orgId ?? "",
      ipAddress: payload.ipAddress ?? null,
      userAgent: payload.userAgent ?? null,
      action: payload.action ?? "login",
    };
  }

  async consumeEnrollmentChallenge(
    challengeId: string,
    code: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const invalidChallengeMessage =
      "MFA enrollment challenge is invalid or expired";
    const challenge = await this.getActiveChallenge(
      challengeId,
      "mfa_enrollment",
      invalidChallengeMessage,
    );
    if (!challenge.userId) {
      throw new UnauthorizedException(invalidChallengeMessage);
    }

    this.assertChallengeRequesterMatches(challenge, ipAddress, userAgent);

    // Atomically claim the challenge BEFORE verifyEnrollment: verifyEnrollment
    // rotates the TOTP secret and regenerates the recovery codes, so two
    // concurrent completes must not both run it — the loser's rotation would
    // invalidate the recovery codes returned to the winner.
    await this.consumeChallengeOrThrow(challenge.id, invalidChallengeMessage);

    let enrollment: Awaited<ReturnType<typeof this.verifyEnrollment>>;
    try {
      enrollment = await this.verifyEnrollment(challenge.userId, code);
    } catch (error) {
      if (this.isMfaCodeFailure(error)) {
        // Wrong code: give the challenge back so the user can retry with the
        // same challenge instead of restarting the whole enrollment flow.
        await this.prisma.authChallenge
          .updateMany({
            where: { id: challenge.id, consumedAt: { not: null } },
            data: { consumedAt: null },
          })
          .catch(() => undefined);
      }
      return this.recordChallengeFailure(
        challenge.id,
        invalidChallengeMessage,
        error,
      );
    }

    const payload = this.parseLoginChallengePayload(challenge.payload);
    return {
      userId: challenge.userId,
      orgId: payload.orgId ?? challenge.orgId ?? "",
      ipAddress: payload.ipAddress ?? null,
      userAgent: payload.userAgent ?? null,
      action: payload.action ?? "login",
      recoveryCodes: enrollment.recoveryCodes,
    };
  }

  private async verifyFactorOrRecoveryCode(userId: string, code: string) {
    const factor = await this.prisma.userTotpFactor.findUnique({
      where: { userId },
    });
    const secret = factor
      ? await this.authSecurity.decodeSecret(factor.secret)
      : null;
    if (
      factor &&
      factor.verifiedAt &&
      !factor.disabledAt &&
      secret &&
      verifyTotpCode(secret, code)
    ) {
      await this.prisma.userTotpFactor.update({
        where: { userId },
        data: {
          lastUsedAt: new Date(),
        },
      });
      return "totp";
    }

    const recoveryCode = await this.prisma.userRecoveryCode.findFirst({
      where: {
        userId,
        codeHash: hashOpaqueToken(code.trim().toUpperCase()),
        usedAt: null,
      },
    });
    if (!recoveryCode) {
      throw new UnauthorizedException("Invalid MFA verification code");
    }
    await this.prisma.$transaction(async (tx) => {
      // Atomic single-use claim: two concurrent logins must not both consume
      // the same recovery code (findFirst above is racy on its own).
      const claimed = await tx.userRecoveryCode.updateMany({
        where: { id: recoveryCode.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new UnauthorizedException("Invalid MFA verification code");
      }
      await tx.userTotpFactor.updateMany({
        where: { userId },
        data: { lastUsedAt: new Date() },
      });
    });
    return "recovery_code";
  }

  private get maxChallengeAttempts() {
    return Math.max(
      1,
      Math.floor(this.env.authMfaChallengeConfig.maxAttempts),
    );
  }

  private async consumeChallengeOrThrow(challengeId: string, message: string) {
    const result = await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        lockedAt: null,
        failedAttempts: { lt: this.maxChallengeAttempts },
        expiresAt: { gt: new Date() },
      },
      data: {
        consumedAt: new Date(),
      },
    });
    if (result.count !== 1) {
      await this.throwInactiveChallenge(challengeId, message);
    }
  }

  private async recordChallengeFailure(
    challengeId: string,
    message: string,
    error: unknown,
  ): Promise<never> {
    if (!this.isMfaCodeFailure(error)) {
      throw error;
    }

    const result = await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        lockedAt: null,
        failedAttempts: { lt: this.maxChallengeAttempts },
        expiresAt: { gt: new Date() },
      },
      data: {
        failedAttempts: { increment: 1 },
      },
    });
    if (result.count !== 1) {
      await this.throwInactiveChallenge(challengeId, message);
    }

    const updated = await this.prisma.authChallenge.findUnique({
      where: { id: challengeId },
      select: { failedAttempts: true },
    });
    if ((updated?.failedAttempts ?? 0) >= this.maxChallengeAttempts) {
      await this.lockChallenge(challengeId);
      throw new TooManyRequestsException(MFA_CHALLENGE_LOCKED_MESSAGE);
    }

    throw error;
  }

  private async throwInactiveChallenge(
    challengeId: string,
    message: string,
  ): Promise<never> {
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { id: challengeId },
      select: {
        failedAttempts: true,
        lockedAt: true,
      },
    });
    if (
      challenge?.lockedAt ||
      (challenge?.failedAttempts ?? 0) >= this.maxChallengeAttempts
    ) {
      await this.lockChallenge(challengeId);
      throw new TooManyRequestsException(MFA_CHALLENGE_LOCKED_MESSAGE);
    }

    throw new UnauthorizedException(message);
  }

  private async lockChallenge(challengeId: string) {
    await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        lockedAt: null,
      },
      data: {
        lockedAt: new Date(),
      },
    });
  }

  private isMfaCodeFailure(error: unknown) {
    if (!(error instanceof HttpException)) {
      return false;
    }

    const response = error.getResponse();
    if (typeof response === "string") {
      return response === MFA_CODE_FAILURE_MESSAGE;
    }
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return error.message === MFA_CODE_FAILURE_MESSAGE;
    }

    const message = (response as { message?: unknown }).message;
    if (typeof message === "string") {
      return message === MFA_CODE_FAILURE_MESSAGE;
    }
    return (
      Array.isArray(message) && message.includes(MFA_CODE_FAILURE_MESSAGE)
    );
  }

  private async isOrgAdmin(userId: string, orgId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          userId,
          orgId,
        },
      },
      include: {
        role: true,
        roles: {
          include: {
            role: true,
          },
        },
      },
    });
    if (!membership) {
      return false;
    }

    const names = [
      membership.role?.name,
      ...(membership.roles ?? []).map((entry) => entry.role?.name),
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());

    return names.includes("admin");
  }

  private assertChallengeRequesterMatches(
    challenge: {
      payload: Prisma.JsonValue;
    },
    ipAddress?: string,
    userAgent?: string,
  ) {
    const payload = this.parseLoginChallengePayload(challenge.payload);
    if (!payload.ipAddress && !payload.userAgent) {
      return;
    }

    if (payload.ipAddress && ipAddress) {
      const recordedIp = this.normalizeIp(payload.ipAddress);
      const callerIp = this.normalizeIp(ipAddress);
      if (callerIp && recordedIp && recordedIp !== callerIp) {
        throw new UnauthorizedException(
          "MFA enrollment challenge is invalid or expired",
        );
      }
    }

    if (payload.userAgent && userAgent && payload.userAgent !== userAgent) {
      throw new UnauthorizedException(
        "MFA enrollment challenge is invalid or expired",
      );
    }
  }

  private normalizeIp(ip: string): string {
    return ip.trim().replace(/^::ffff:/, "").toLowerCase();
  }

  private parseLoginChallengePayload(
    value: Prisma.JsonValue,
  ): Partial<LoginChallengePayload> {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return {};
    }

    return {
      orgId: typeof value.orgId === "string" ? value.orgId : undefined,
      ipAddress:
        typeof value.ipAddress === "string" ? value.ipAddress : undefined,
      userAgent:
        typeof value.userAgent === "string" ? value.userAgent : undefined,
      action: typeof value.action === "string" ? value.action : undefined,
    };
  }

  private async getActiveChallenge(
    challengeId: string,
    type: "mfa_login" | "mfa_enrollment",
    message: string,
  ) {
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { id: challengeId },
    });
    if (!challenge || challenge.type !== type) {
      throw new UnauthorizedException(message);
    }
    if (
      challenge.lockedAt ||
      challenge.failedAttempts >= this.maxChallengeAttempts
    ) {
      await this.lockChallenge(challenge.id);
      throw new TooManyRequestsException(MFA_CHALLENGE_LOCKED_MESSAGE);
    }
    if (challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException(message);
    }
    return challenge;
  }
}

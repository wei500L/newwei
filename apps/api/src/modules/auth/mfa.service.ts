import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import { AuthSecurityService } from "./auth-security.service";
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashOpaqueToken,
  verifyTotpCode,
} from "./auth-flow.utils";

interface LoginChallengePayload {
  orgId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const MFA_CHALLENGE_TTL_MINUTES = 10;
const MFA_ISSUER = "Modular";

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSecurity: AuthSecurityService,
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

    await this.prisma.$transaction(async (tx) => {
      await tx.userRecoveryCode.deleteMany({
        where: { userId },
      });
      await tx.userTotpFactor.upsert({
        where: { userId },
        update: {
          secret: storedSecret as Prisma.InputJsonValue,
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
    });

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

    const secret = await this.authSecurity.decodeSecret(factor.secret);
    if (!secret || !verifyTotpCode(secret, code)) {
      throw new BadRequestException("Invalid MFA verification code");
    }

    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.userTotpFactor.update({
        where: { userId },
        data: {
          verifiedAt: new Date(),
          disabledAt: null,
          lastUsedAt: new Date(),
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

  async shouldRequireMfa(userId: string, orgId: string) {
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
      return enabled;
    }

    const isAdmin = await this.isOrgAdmin(userId, orgId);
    const applies = policy === "all_users" || (policy === "admins_only" && isAdmin);
    if (!applies) {
      return enabled;
    }
    if (!enabled) {
      throw new UnauthorizedException("MFA enrollment required");
    }
    return true;
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
        expiresAt: new Date(
          Date.now() + MFA_CHALLENGE_TTL_MINUTES * 60_000,
        ),
      },
    });

    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  async consumeLoginChallenge(challengeId: string, code: string) {
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { id: challengeId },
    });
    if (!challenge || challenge.type !== "mfa_login") {
      throw new UnauthorizedException("MFA challenge is invalid or expired");
    }
    if (challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException("MFA challenge is invalid or expired");
    }
    if (!challenge.userId) {
      throw new UnauthorizedException("MFA challenge is invalid or expired");
    }

    await this.verifyFactorOrRecoveryCode(challenge.userId, code);
    await this.prisma.authChallenge.update({
      where: { id: challenge.id },
      data: {
        consumedAt: new Date(),
      },
    });

    const payload = this.parseLoginChallengePayload(challenge.payload);
    return {
      userId: challenge.userId,
      orgId: payload.orgId ?? challenge.orgId ?? "",
      ipAddress: payload.ipAddress ?? null,
      userAgent: payload.userAgent ?? null,
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
      await tx.userRecoveryCode.update({
        where: { id: recoveryCode.id },
        data: { usedAt: new Date() },
      });
      await tx.userTotpFactor.updateMany({
        where: { userId },
        data: { lastUsedAt: new Date() },
      });
    });
    return "recovery_code";
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
    };
  }
}

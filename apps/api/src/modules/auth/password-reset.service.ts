import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import bcrypt from "bcrypt";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { ActionRateLimitService } from "../cache/action-rate-limit.service";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";

import {
  generateOpaqueToken,
  hashOpaqueToken,
  normalizeEmailAddress,
} from "./auth-flow.utils";

const PASSWORD_RESET_TTL_MINUTES = 30;

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly actionRateLimit: ActionRateLimitService,
  ) {}

  async requestReset(params: {
    email: string;
    ipAddress?: string;
    userAgent?: string;
    baseUrl: string;
  }) {
    await this.actionRateLimit.enforcePasswordResetRequest(
      params.email,
      params.ipAddress,
    );
    const normalizedEmail = normalizeEmailAddress(params.email);
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        memberships: {
          orderBy: { createdAt: "asc" },
          include: { org: true },
        },
      },
    });

    if (!user || !user.isActive) {
      return { ok: true as const };
    }

    const rawToken = generateOpaqueToken();
    const resetUrl = new URL("/reset-password", params.baseUrl);
    resetUrl.searchParams.set("token", rawToken);

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(rawToken),
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000),
      },
    });

    await this.emailService.send({
      to: normalizedEmail,
      subject: "Password reset link",
      text: `Use this link to reset your password: ${resetUrl.toString()}`,
      html: `<p>Use this link to reset your password:</p><p><a href="${resetUrl.toString()}">${resetUrl.toString()}</a></p>`,
    });

    const orgId = user.memberships[0]?.orgId;
    if (orgId) {
      await writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId,
            actorId: user.id,
            resource: "auth",
            action: "password_reset_requested",
            metadata: { email: normalizedEmail },
            ipAddress: params.ipAddress,
          },
        },
        {
          orgId,
          actorId: user.id,
          resource: "auth",
          action: "password_reset_requested",
        },
      );
    }

    return { ok: true as const };
  }

  async resetPassword(params: {
    token: string;
    password: string;
    ipAddress?: string;
  }) {
    const tokenHash = hashOpaqueToken(params.token.trim());
    const resetRecord = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            memberships: {
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    if (
      !resetRecord ||
      resetRecord.usedAt ||
      resetRecord.expiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException(
        "Password reset token is invalid or expired",
      );
    }
    if (params.password.trim().length < 8) {
      throw new BadRequestException("Password must be at least 8 characters");
    }

    const passwordHash = await bcrypt.hash(params.password.trim(), 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: resetRecord.userId },
        data: {
          passwordHash,
        },
      });
      await tx.passwordResetToken.updateMany({
        where: {
          userId: resetRecord.userId,
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });
      await tx.refreshToken.updateMany({
        where: {
          userId: resetRecord.userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
    });

    const orgId = resetRecord.user.memberships[0]?.orgId;
    if (orgId) {
      await writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId,
            actorId: resetRecord.userId,
            resource: "auth",
            action: "password_reset_completed",
            ipAddress: params.ipAddress,
          },
        },
        {
          orgId,
          actorId: resetRecord.userId,
          resource: "auth",
          action: "password_reset_completed",
        },
      );
    }

    return { ok: true as const };
  }
}

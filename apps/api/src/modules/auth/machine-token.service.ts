import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import type { AuthenticatedUser } from "./auth.service";
import { PlatformAccessService } from "./platform-access.service";

const MACHINE_TOKEN_PREFIX = "mtk_";
const MACHINE_TOKEN_ALLOWED_PERMISSIONS = new Set([
  "metrics.read",
]);

export interface CreateMachineTokenInput {
  orgId: string;
  actorId?: string;
  name: string;
  permissions: string[];
  expiresAt?: Date | null;
}

export interface CreateMachineTokenResult {
  id: string;
  name: string;
  token: string;
  permissions: string[];
  expiresAt: string | null;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizePermissions(permissions: string[]): string[] {
  return Array.from(
    new Set(
      permissions
        .map((permission) => permission.trim())
        .filter((permission) => MACHINE_TOKEN_ALLOWED_PERMISSIONS.has(permission)),
    ),
  );
}

@Injectable()
export class MachineTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformAccess: PlatformAccessService,
  ) {}

  isMachineToken(value: string | undefined): boolean {
    return typeof value === "string" && value.startsWith(MACHINE_TOKEN_PREFIX);
  }

  async create(input: CreateMachineTokenInput): Promise<CreateMachineTokenResult> {
    const permissions = normalizePermissions(input.permissions);
    if (permissions.length === 0) {
      throw new BadRequestException("At least one supported permission is required");
    }

    const token = `${MACHINE_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const created = await this.prisma.machineAccessToken.create({
      data: {
        orgId: input.orgId,
        name: input.name.trim(),
        tokenHash: hashToken(token),
        permissions: toPrismaJsonValue(permissions),
        createdById: input.actorId,
        expiresAt: input.expiresAt ?? null,
      },
    });

    return {
      id: created.id,
      name: created.name,
      token,
      permissions,
      expiresAt: created.expiresAt?.toISOString() ?? null,
    };
  }

  async list(orgId: string) {
    return this.prisma.machineAccessToken.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        permissions: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
  }

  async revoke(orgId: string, tokenId: string) {
    const updated = await this.prisma.machineAccessToken.updateMany({
      where: { id: tokenId, orgId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new BadRequestException("Machine token not found or already revoked");
    }
    return { revoked: true };
  }

  async rotate(orgId: string, tokenId: string): Promise<CreateMachineTokenResult> {
    const record = await this.prisma.machineAccessToken.findFirst({
      where: { id: tokenId, orgId, revokedAt: null },
    });
    if (!record) {
      throw new BadRequestException("Machine token not found or already revoked");
    }
    const rawPermissions = record.permissions as Prisma.JsonValue;
    const permissions = Array.isArray(rawPermissions)
      ? rawPermissions.filter((entry): entry is string => typeof entry === "string")
      : [];
    await this.revoke(orgId, tokenId);
    return this.create({
      orgId,
      actorId: record.createdById ?? undefined,
      name: record.name,
      permissions,
      expiresAt: record.expiresAt,
    });
  }

  async validate(token: string): Promise<AuthenticatedUser> {    const tokenHash = hashToken(token);
    const record = await this.prisma.machineAccessToken.findUnique({
      where: { tokenHash },
      include: { org: true },
    });
    const now = new Date();
    if (
      !record ||
      record.revokedAt ||
      (record.expiresAt && record.expiresAt <= now) ||
      !record.org.isActive
    ) {
      throw new UnauthorizedException("Invalid machine token");
    }

    await this.prisma.machineAccessToken
      .update({
        where: { id: record.id },
        data: { lastUsedAt: now },
      })
      .catch(() => undefined);

    const rawPermissions = record.permissions as Prisma.JsonValue;
    const permissions = Array.isArray(rawPermissions)
      ? rawPermissions.filter((entry): entry is string => typeof entry === "string")
      : [];

    return {
      id: `machine:${record.id}`,
      email: `${record.name}@machine.local`,
      emailVerified: null,
      lastLoginAt: null,
      pendingEmail: null,
      orgId: record.orgId,
      primaryRoleId: null,
      roleIds: [],
      permissions,
      firstName: record.name,
      lastName: "Machine",
      avatarUrl: null,
      isActive: true,
      planTier: record.org.planTier ?? null,
      subscriptionStatus: record.org.subscriptionStatus ?? null,
      globalRoles: [],
      mfaEnabled: false,
      mfaRequired: false,
      mfaEnrollmentRequired: false,
    };
  }

  /**
   * SEC-03：机器令牌能否读取平台级指标。
   *
   * 按 bearer 的 SHA-256 查 MachineAccessToken，不看 mtk_ 前缀，也不看
   * JWT / permissions JSON 里有没有平台身份。查不到行 → absent（调用方走
   * 人类平台管理员校验）。查到行时，只有 createdById 当前在
   * GlobalRoleAssignment 里持有 platform_admin 才允许。普通组织管理员
   * 创建的旧令牌、createdBy 已清空、已撤销、已过期或组织停用，一律拒绝。
   * 轮换会复制原来的 createdById，所以授权跟着创建者的当前平台角色走，
   * 不会因为组织管理员持有新密钥而升级。
   */
  async resolvePlatformMetricsAccess(
    bearer: string | undefined,
  ): Promise<"absent" | "machine-allowed" | "machine-denied"> {
    if (!bearer) {
      return "absent";
    }
    const record = await this.prisma.machineAccessToken.findUnique({
      where: { tokenHash: hashToken(bearer) },
      select: {
        createdById: true,
        revokedAt: true,
        expiresAt: true,
        org: { select: { isActive: true } },
      },
    });
    if (!record) {
      return "absent";
    }
    const now = new Date();
    if (
      record.revokedAt ||
      (record.expiresAt && record.expiresAt <= now) ||
      !record.org?.isActive ||
      !record.createdById
    ) {
      return "machine-denied";
    }
    const allowed = await this.platformAccess.isPlatformAdmin(record.createdById);
    return allowed ? "machine-allowed" : "machine-denied";
  }
}

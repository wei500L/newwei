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
  constructor(private readonly prisma: PrismaService) {}

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
}

import { DEFAULT_ROLES } from "@modular/config";
import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { hasMembershipPermission } from "../../common/authz/membership-permissions";
import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";

// org.write is admin-only (see @modular/config DEFAULT_ROLES). Managing an org must
// bind the permission check to the TARGET org, not the caller's active-org claims.
const ORG_WRITE_PERMISSION = "org.write";

export interface OrgListItem {
  id: string;
  name: string;
  slug: string;
  description?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationOption {
  id: string;
  name?: string;
  slug?: string;
  isActive?: boolean;
}

export interface CreateOrgInput {
  name: string;
  slug: string;
  description?: string;
}

export interface UpdateOrgInput {
  id: string;
  name?: string;
  slug?: string;
  description?: string | null;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === "P2002";
}

@Injectable()
export class OrgService {
  constructor(private readonly prisma: PrismaService) {}

  private static readonly SLUG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}-]{1,62}[\p{L}\p{N}]$/u;

  async listOrganizationsForUser(userId: string): Promise<OrgListItem[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: { org: true }
    });

    const map = new Map<string, OrgListItem>();
    for (const membership of memberships) {
      map.set(membership.orgId, {
        id: membership.org.id,
        name: membership.org.name,
        slug: membership.org.slug,
        description: membership.org.description ?? undefined,
        isActive: membership.org.isActive && (membership.isActive ?? true),
        createdAt: membership.org.createdAt,
        updatedAt: membership.org.updatedAt
      });
    }
    return Array.from(map.values());
  }

  async listOrganizationOptionsForUser(userId: string): Promise<OrganizationOption[]> {
    const orgs = await this.listOrganizationsForUser(userId);
    return orgs.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      isActive: org.isActive
    }));
  }

  async createOrg(actorId: string, input: CreateOrgInput): Promise<OrgListItem> {
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();
    const description = input.description?.trim() || undefined;

    if (!name) {
      throw new BadRequestException("Organization name is required");
    }
    if (!slug) {
      throw new BadRequestException("Organization slug is required");
    }
    if (!OrgService.SLUG_PATTERN.test(slug)) {
      throw new BadRequestException("Invalid organization slug");
    }

    let org: {
      id: string;
      name: string;
      slug: string;
      description: string | null;
      isActive: boolean;
      createdAt: Date;
      updatedAt: Date;
    };

    try {
      org = await this.prisma.$transaction(async (tx) => {
        const createdOrg = await tx.org.create({
          data: {
            name,
            slug,
            description,
            isActive: true
          }
        });

        const permissionRows = await tx.permission.findMany();
        const permissionByName = new Map(permissionRows.map((row) => [row.name, row.id]));
        const allPermissionIds = permissionRows.map((row) => row.id);
        const bootstrapWarnings: { role: string; missingPermissions: string[] }[] = [];

        for (const roleDef of DEFAULT_ROLES) {
          const role = await tx.role.create({
            data: {
              name: roleDef.name,
              description: roleDef.description,
              orgId: createdOrg.id,
              isSystem: roleDef.isSystem ?? false
            }
          });

          const desiredPermissionNames = roleDef.permissions;
          const missingPermissions = desiredPermissionNames.filter(
            (permissionName) => !permissionByName.has(permissionName)
          );
          if (missingPermissions.length > 0) {
            bootstrapWarnings.push({ role: roleDef.name, missingPermissions });
          }

          const permissionIds =
            roleDef.name === "admin"
              ? allPermissionIds
              : desiredPermissionNames
                  .map((permissionName) => permissionByName.get(permissionName))
                  .filter((permissionId): permissionId is string => typeof permissionId === "string");

          if (permissionIds.length > 0) {
            await tx.rolePermission.createMany({
              data: permissionIds.map((permissionId) => ({
                roleId: role.id,
                permissionId
              }))
            });
          }
        }

        const adminRole = await tx.role.findFirstOrThrow({
          where: { orgId: createdOrg.id, name: "admin" }
        });

        const membership = await tx.membership.create({
          data: {
            userId: actorId,
            orgId: createdOrg.id,
            roleId: adminRole.id
          }
        });

        await tx.membershipRole.create({
          data: {
            membershipId: membership.id,
            orgId: createdOrg.id,
            roleId: adminRole.id
          }
        });

        const metadata: Record<string, unknown> = { slug, name };
        if (bootstrapWarnings.length > 0) {
          metadata.bootstrapWarnings = bootstrapWarnings;
        }

        await writeAuditLogBestEffort(
          tx,
          {
            data: {
              orgId: createdOrg.id,
              actorId,
              resource: "org",
              action: "create",
              metadata: toPrismaJsonValue(metadata)
            }
          },
          { orgId: createdOrg.id, actorId, resource: "org", action: "create" }
        );

        return createdOrg;
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new BadRequestException("Organization slug already exists");
      }
      throw error;
    }

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      description: org.description ?? undefined,
      isActive: org.isActive,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt
    };
  }

  async updateOrg(actorId: string, input: UpdateOrgInput): Promise<OrgListItem> {
    const orgId = input.id.trim();
    if (!orgId) {
      throw new BadRequestException("Organization id is required");
    }

    await this.assertActorCanManageOrg(actorId, orgId);

    const data: Prisma.OrgUpdateInput = {};
    if (typeof input.name === "string") {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException("Organization name is required");
      }
      data.name = name;
    }
    if (typeof input.slug === "string") {
      const slug = input.slug.trim().toLowerCase();
      if (!slug) {
        throw new BadRequestException("Organization slug is required");
      }
      if (!OrgService.SLUG_PATTERN.test(slug)) {
        throw new BadRequestException("Invalid organization slug");
      }
      data.slug = slug;
    }
    if (typeof input.description !== "undefined") {
      const description = input.description === null ? null : input.description?.trim() || null;
      data.description = description;
    }

    let updated: {
      id: string;
      name: string;
      slug: string;
      description: string | null;
      isActive: boolean;
      createdAt: Date;
      updatedAt: Date;
    };

    try {
      updated = await this.prisma.org.update({
        where: { id: orgId },
        data
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new BadRequestException("Organization slug already exists");
      }
      throw error;
    }

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "org",
          action: "update",
          metadata: {
            name: typeof input.name === "string" ? input.name.trim() : undefined,
            slug: typeof input.slug === "string" ? input.slug.trim().toLowerCase() : undefined,
            description:
              typeof input.description !== "undefined" ? input.description ?? null : undefined
          }
        }
      },
      { orgId, actorId, resource: "org", action: "update" }
    );

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      description: updated.description ?? undefined,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  }

  async setOrgActive(actorId: string, orgId: string, isActive: boolean): Promise<OrgListItem> {
    const normalizedOrgId = orgId.trim();
    await this.assertActorCanManageOrg(actorId, normalizedOrgId);

    const updated = await this.prisma.org.update({
      where: { id: normalizedOrgId },
      data: { isActive }
    });

    const auditAction = isActive ? "enable" : "disable";
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: normalizedOrgId,
          actorId,
          resource: "org",
          action: auditAction,
          metadata: { isActive }
        }
      },
      { orgId: normalizedOrgId, actorId, resource: "org", action: auditAction }
    );

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      description: updated.description ?? undefined,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  }

  private async assertActorCanManageOrg(actorId: string, orgId: string): Promise<void> {
    if (!actorId) {
      throw new ForbiddenException("Missing actor context");
    }
    if (!orgId) {
      throw new BadRequestException("Organization id is required");
    }

    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          userId: actorId,
          orgId
        }
      },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } }
          }
        },
        roles: {
          include: {
            role: {
              include: {
                permissions: { include: { permission: true } }
              }
            }
          }
        }
      }
    });

    if (!membership) {
      throw new ForbiddenException("Not a member of the organization");
    }

    // Authorization must be re-derived within the TARGET org. Without this, a plain
    // member of another org (whose active-org claims carry org.write) could rename,
    // re-slug, or disable that org — cross-tenant privilege escalation / DoS.
    if (!hasMembershipPermission(membership, ORG_WRITE_PERMISSION)) {
      throw new ForbiddenException("org.write permission required in the target organization");
    }
  }
}

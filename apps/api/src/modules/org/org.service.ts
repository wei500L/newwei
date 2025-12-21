import { DEFAULT_ROLES } from "@modular/config";
import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";

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

@Injectable()
export class OrgService {
  constructor(private readonly prisma: PrismaService) {}

  private static readonly SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

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
        isActive: membership.org.isActive,
        createdAt: membership.org.createdAt,
        updatedAt: membership.org.updatedAt
      });
    }
    return Array.from(map.values());
  }

  async listOrganizationOptionsForUser(userId: string): Promise<OrganizationOption[]> {
    const orgs = await this.listOrganizationsForUser(userId);
    return orgs.map((org) => ({ id: org.id, name: org.name, slug: org.slug }));
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

    const org = await this.prisma.$transaction(async (tx) => {
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
            metadata
          }
        },
        { orgId: createdOrg.id, actorId, resource: "org", action: "create" }
      );

      return createdOrg;
    });

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

    await this.assertActorMembership(actorId, orgId);

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

    const updated = await this.prisma.org.update({
      where: { id: orgId },
      data
    });

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
    await this.assertActorMembership(actorId, normalizedOrgId);

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

  private async assertActorMembership(actorId: string, orgId: string): Promise<void> {
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
      }
    });

    if (!membership) {
      throw new ForbiddenException("Not a member of the organization");
    }
  }
}

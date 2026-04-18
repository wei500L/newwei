import bcrypt from "bcrypt";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";

import {
  generateOpaqueToken,
  hashOpaqueToken,
  normalizeEmailAddress,
} from "./auth-flow.utils";

interface CreateInviteInput {
  email: string;
  firstName?: string;
  lastName?: string;
  primaryRoleId: string;
  roleIds: string[];
}

const INVITE_TTL_DAYS = 7;

@Injectable()
export class OrgInviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async listInvites(orgId: string, actorId: string) {
    await this.assertOrgAdmin(actorId, orgId);
    return this.prisma.orgInvite.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      include: {
        primaryRole: true,
      },
    });
  }

  async createInvite(
    orgId: string,
    actorId: string,
    input: CreateInviteInput,
    baseUrl: string,
  ) {
    await this.assertOrgAdmin(actorId, orgId);
    const normalizedEmail = normalizeEmailAddress(input.email);
    const roleIds = this.normalizeRoleIds(input.roleIds, input.primaryRoleId);
    await this.ensureRoleSet(orgId, input.primaryRoleId, roleIds);

    const { rawToken, tokenHash, expiresAt } = this.issueInviteToken();
    const invite = await this.prisma.orgInvite.create({
      data: {
        orgId,
        email: normalizedEmail,
        firstName: input.firstName?.trim() || null,
        lastName: input.lastName?.trim() || null,
        primaryRoleId: input.primaryRoleId,
        roleIds: roleIds as unknown as Prisma.InputJsonValue,
        invitedById: actorId,
        tokenHash,
        expiresAt,
      },
      include: {
        org: true,
        primaryRole: true,
      },
    });

    await this.sendInviteEmail(invite, rawToken, baseUrl);
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "users",
          action: "invite_create",
          metadata: {
            inviteId: invite.id,
            email: normalizedEmail,
            primaryRoleId: input.primaryRoleId,
            roleIds,
          },
        },
      },
      {
        orgId,
        actorId,
        resource: "users",
        action: "invite_create",
      },
    );

    return invite;
  }

  async resendInvite(orgId: string, actorId: string, inviteId: string, baseUrl: string) {
    await this.assertOrgAdmin(actorId, orgId);
    const invite = await this.prisma.orgInvite.findFirst({
      where: {
        id: inviteId,
        orgId,
      },
      include: {
        org: true,
        primaryRole: true,
      },
    });
    if (!invite) {
      throw new NotFoundException("Invite not found");
    }
    if (invite.status !== "pending") {
      throw new BadRequestException("Only pending invites can be resent");
    }

    const { rawToken, tokenHash, expiresAt } = this.issueInviteToken();
    const updated = await this.prisma.orgInvite.update({
      where: { id: invite.id },
      data: {
        tokenHash,
        expiresAt,
      },
      include: {
        org: true,
        primaryRole: true,
      },
    });

    await this.sendInviteEmail(updated, rawToken, baseUrl);
    return updated;
  }

  async revokeInvite(orgId: string, actorId: string, inviteId: string) {
    await this.assertOrgAdmin(actorId, orgId);
    const invite = await this.prisma.orgInvite.findFirst({
      where: {
        id: inviteId,
        orgId,
      },
    });
    if (!invite) {
      throw new NotFoundException("Invite not found");
    }

    return this.prisma.orgInvite.update({
      where: { id: invite.id },
      data: {
        status: "revoked",
        revokedAt: new Date(),
      },
    });
  }

  async getInviteByToken(token: string) {
    const invite = await this.findInviteByToken(token);
    return {
      id: invite.id,
      email: invite.email,
      firstName: invite.firstName,
      lastName: invite.lastName,
      org: {
        id: invite.org.id,
        name: invite.org.name,
        slug: invite.org.slug,
      },
      primaryRole: {
        id: invite.primaryRole.id,
        name: invite.primaryRole.name,
      },
      expiresAt: invite.expiresAt,
      status: invite.status,
    };
  }

  async acceptInvite(params: {
    token: string;
    currentUserId?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
  }) {
    const invite = await this.findInviteByToken(params.token);
    const roleIds = this.readRoleIds(invite.roleIds, invite.primaryRoleId);
    await this.ensureRoleSet(invite.orgId, invite.primaryRoleId, roleIds);

    let userId = params.currentUserId;
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });
      if (!user || normalizeEmailAddress(user.email) !== invite.email) {
        throw new ForbiddenException("Signed-in user does not match invite email");
      }
    } else {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: invite.email },
      });
      if (existingUser) {
        throw new ForbiddenException("Please sign in with the invited email to accept this invite");
      }
      const password = params.password?.trim() ?? "";
      const firstName = params.firstName?.trim() ?? invite.firstName ?? "";
      const lastName = params.lastName?.trim() ?? invite.lastName ?? "";
      if (password.length < 8) {
        throw new BadRequestException("Password must be at least 8 characters");
      }
      if (!firstName || !lastName) {
        throw new BadRequestException("First and last name are required");
      }
      const createdUser = await this.prisma.user.create({
        data: {
          email: invite.email,
          emailVerified: new Date(),
          passwordHash: await bcrypt.hash(password, 10),
          firstName,
          lastName,
        },
      });
      userId = createdUser.id;
    }

    const membership = await this.prisma.$transaction(async (tx) => {
      const existingMembership = await tx.membership.findUnique({
        where: {
          userId_orgId: {
            userId: userId!,
            orgId: invite.orgId,
          },
        },
      });

      const nextMembership = existingMembership
        ? await tx.membership.update({
            where: { id: existingMembership.id },
            data: {
              roleId: invite.primaryRoleId,
              isActive: true,
            },
          })
        : await tx.membership.create({
            data: {
              userId: userId!,
              orgId: invite.orgId,
              roleId: invite.primaryRoleId,
            },
          });

      await tx.membershipRole.deleteMany({
        where: {
          membershipId: nextMembership.id,
        },
      });
      await tx.membershipRole.createMany({
        data: roleIds.map((roleId) => ({
          membershipId: nextMembership.id,
          orgId: invite.orgId,
          roleId,
        })),
      });

      await tx.orgInvite.update({
        where: { id: invite.id },
        data: {
          status: "accepted",
          acceptedAt: new Date(),
          acceptedById: userId,
        },
      });

      return tx.membership.findUniqueOrThrow({
        where: { id: nextMembership.id },
        include: {
          org: true,
        },
      });
    });

    return membership;
  }

  private async sendInviteEmail(
    invite: {
      email: string;
      org: { name: string; slug: string };
      primaryRole: { name: string };
    },
    rawToken: string,
    baseUrl: string,
  ) {
    const inviteUrl = new URL(`/invite/${rawToken}`, baseUrl);
    await this.emailService.send({
      to: invite.email,
      subject: `Invitation to join ${invite.org.name}`,
      text: `You have been invited to join ${invite.org.name} as ${invite.primaryRole.name}. Accept the invite here: ${inviteUrl.toString()}`,
      html: `<p>You have been invited to join <strong>${invite.org.name}</strong> as <strong>${invite.primaryRole.name}</strong>.</p><p><a href="${inviteUrl.toString()}">${inviteUrl.toString()}</a></p>`,
    });
  }

  private issueInviteToken() {
    const rawToken = generateOpaqueToken();
    return {
      rawToken,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    };
  }

  private normalizeRoleIds(roleIds: string[], primaryRoleId: string) {
    const ids = Array.from(
      new Set(
        [primaryRoleId, ...roleIds]
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    );
    if (!ids.includes(primaryRoleId)) {
      ids.unshift(primaryRoleId);
    }
    return ids;
  }

  private readRoleIds(value: Prisma.JsonValue, primaryRoleId: string) {
    if (!Array.isArray(value)) {
      return [primaryRoleId];
    }
    const ids = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return this.normalizeRoleIds(ids, primaryRoleId);
  }

  private async ensureRoleSet(orgId: string, primaryRoleId: string, roleIds: string[]) {
    const roles = await this.prisma.role.findMany({
      where: {
        orgId,
        id: {
          in: roleIds,
        },
      },
    });
    if (roles.length !== roleIds.length) {
      throw new BadRequestException("One or more roles are invalid");
    }
    if (!roleIds.includes(primaryRoleId)) {
      throw new BadRequestException("Primary role must be included in roleIds");
    }
  }

  private async assertOrgAdmin(userId: string, orgId: string) {
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
      throw new ForbiddenException("Organization admin access required");
    }

    const roleNames = [
      membership.role?.name,
      ...(membership.roles ?? []).map((entry) => entry.role?.name),
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());

    if (!roleNames.includes("admin")) {
      throw new ForbiddenException("Organization admin access required");
    }
  }

  private async findInviteByToken(token: string) {
    const invite = await this.prisma.orgInvite.findUnique({
      where: {
        tokenHash: hashOpaqueToken(token.trim()),
      },
      include: {
        org: true,
        primaryRole: true,
      },
    });
    if (!invite) {
      throw new NotFoundException("Invite not found");
    }
    if (invite.status !== "pending") {
      throw new UnauthorizedException("Invite is no longer valid");
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException("Invite is no longer valid");
    }
    if (!invite.org.isActive) {
      throw new UnauthorizedException("Invite organization is disabled");
    }
    return invite;
  }
}

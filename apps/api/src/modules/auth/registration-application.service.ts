import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { hasMembershipPermission } from "../../common/authz/membership-permissions";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";
import { OrgService } from "../org/org.service";

import { normalizeEmailAddress } from "./auth-flow.utils";
import { OrgInviteService } from "./org-invite.service";
import { PlatformAccessService } from "./platform-access.service";

@Injectable()
export class RegistrationApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgService: OrgService,
    private readonly inviteService: OrgInviteService,
    private readonly emailService: EmailService,
    private readonly platformAccess: PlatformAccessService,
  ) {}

  async submitNewOrgApplication(input: {
    email: string;
    firstName: string;
    lastName: string;
    orgName: string;
    orgSlug: string;
    description?: string;
  }) {
    const email = normalizeEmailAddress(input.email);
    const orgSlug = input.orgSlug.trim().toLowerCase();

    const existingPending = await this.prisma.registrationApplication.findFirst({
      where: {
        type: "new_org",
        status: "pending",
        email,
      },
      select: { id: true },
    });
    if (existingPending) {
      throw new ConflictException(
        "An application for this email is already pending review",
      );
    }

    const slugTaken = await this.prisma.org.findUnique({
      where: { slug: orgSlug },
      select: { id: true },
    });
    if (slugTaken) {
      throw new ConflictException("Organization slug is already in use");
    }
    const slugPending = await this.prisma.registrationApplication.findFirst({
      where: {
        type: "new_org",
        status: "pending",
        requestedOrgSlug: orgSlug,
      },
      select: { id: true },
    });
    if (slugPending) {
      throw new ConflictException(
        "Organization slug is already pending review",
      );
    }

    return this.prisma.registrationApplication.create({
      data: {
        type: "new_org",
        email,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        requestedOrgName: input.orgName.trim(),
        requestedOrgSlug: orgSlug,
        requestedDescription: input.description?.trim() || null,
      },
    });
  }

  async submitJoinOrgApplication(input: {
    email: string;
    firstName: string;
    lastName: string;
    orgSlug: string;
  }) {
    const org = await this.prisma.org.findUnique({
      where: { slug: input.orgSlug.trim().toLowerCase() },
    });
    if (!org) {
      throw new NotFoundException("Organization not found");
    }

    const email = normalizeEmailAddress(input.email);
    const existingPending = await this.prisma.registrationApplication.findFirst({
      where: {
        type: "join_org",
        status: "pending",
        email,
        orgId: org.id,
      },
      select: { id: true },
    });
    if (existingPending) {
      throw new ConflictException(
        "An application for this email is already pending review",
      );
    }

    return this.prisma.registrationApplication.create({
      data: {
        type: "join_org",
        email,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        orgId: org.id,
      },
      include: {
        org: true,
      },
    });
  }

  async listOrgJoinApplications(orgId: string, actorId: string) {
    await this.assertOrgAdmin(actorId, orgId);
    return this.prisma.registrationApplication.findMany({
      where: {
        orgId,
        type: "join_org",
      },
      orderBy: { createdAt: "desc" },
      include: {
        org: true,
        reviewedBy: true,
      },
    });
  }

  async listPlatformApplications(actorId: string) {
    await this.platformAccess.assertPlatformAdmin(actorId);
    return this.prisma.registrationApplication.findMany({
      where: {
        type: "new_org",
      },
      orderBy: { createdAt: "desc" },
      include: {
        reviewedBy: true,
      },
    });
  }

  async approveJoinApplication(params: {
    actorId: string;
    orgId: string;
    applicationId: string;
    primaryRoleId: string;
    roleIds: string[];
    baseUrl: string;
  }) {
    await this.assertOrgAdmin(params.actorId, params.orgId);
    // Same guards as the invite path: no system admin grants, and the actor
    // can only approve roles whose permissions are within their own scope.
    await this.inviteService.assertRolesAssignable(
      params.actorId,
      params.orgId,
      [...params.roleIds, params.primaryRoleId],
    );
    const application = await this.prisma.registrationApplication.findFirst({
      where: {
        id: params.applicationId,
        orgId: params.orgId,
        type: "join_org",
        status: "pending",
      },
      include: {
        org: true,
      },
    });
    if (!application || !application.orgId) {
      throw new NotFoundException("Registration application not found");
    }

    // Optimistic claim FIRST: only transition from pending so two concurrent
    // approvals cannot both succeed. Creating the invite before claiming
    // would leave a valid 7-day orphan invite when a concurrent approval wins
    // the claim.
    const claimed = await this.prisma.registrationApplication.updateMany({
      where: { id: application.id, status: "pending" },
      data: {
        status: "approved",
        reviewedById: params.actorId,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        "Registration application was already reviewed",
      );
    }

    let invite;
    try {
      invite = await this.inviteService.createInvite(
        application.orgId,
        params.actorId,
        {
          email: application.email,
          firstName: application.firstName,
          lastName: application.lastName,
          primaryRoleId: params.primaryRoleId,
          roleIds: params.roleIds,
        },
        params.baseUrl,
      );
    } catch (error) {
      // Compensation: release the claim so the admin can retry approval.
      await this.prisma.registrationApplication
        .updateMany({
          where: { id: application.id, status: "approved", generatedInviteId: null },
          data: { status: "pending" },
        })
        .catch(() => undefined);
      throw error;
    }

    await this.prisma.registrationApplication.update({
      where: { id: application.id },
      data: { generatedInviteId: invite.id },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: application.orgId ?? params.orgId,
          actorId: params.actorId,
          resource: "registration_application",
          action: "approve_join",
          metadata: {
            applicationId: application.id,
            inviteId: invite.id,
            primaryRoleId: params.primaryRoleId,
            roleIds: params.roleIds,
            email: application.email,
          },
        },
      },
      {
        orgId: application.orgId ?? params.orgId,
        actorId: params.actorId,
        resource: "registration_application",
        action: "approve_join",
      },
    );

    return this.prisma.registrationApplication.findUnique({
      where: { id: application.id },
      include: {
        org: true,
        reviewedBy: true,
      },
    });
  }

  async rejectJoinApplication(params: {
    actorId: string;
    orgId: string;
    applicationId: string;
    reason?: string;
  }) {
    await this.assertOrgAdmin(params.actorId, params.orgId);
    const application = await this.prisma.registrationApplication.findFirst({
      where: {
        id: params.applicationId,
        orgId: params.orgId,
        type: "join_org",
        status: "pending",
      },
    });
    if (!application) {
      throw new NotFoundException("Registration application not found");
    }

    const updated = await this.prisma.registrationApplication.update({
      where: { id: application.id },
      data: {
        status: "rejected",
        decisionReason: params.reason?.trim() || null,
        reviewedById: params.actorId,
        reviewedAt: new Date(),
      },
      include: {
        org: true,
      },
    });

    await this.emailService.send({
      to: updated.email,
      subject: "Registration application update",
      text: `Your request to join ${updated.org?.name ?? "the organization"} was not approved.`,
      html: `<p>Your request to join <strong>${updated.org?.name ?? "the organization"}</strong> was not approved.</p>`,
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: params.orgId,
          actorId: params.actorId,
          resource: "registration_application",
          action: "reject_join",
          metadata: {
            applicationId: application.id,
            decisionReason: params.reason?.trim() || null,
            email: application.email,
          },
        },
      },
      {
        orgId: params.orgId,
        actorId: params.actorId,
        resource: "registration_application",
        action: "reject_join",
      },
    );

    return updated;
  }

  async approveNewOrgApplication(params: {
    actorId: string;
    applicationId: string;
    baseUrl: string;
  }) {
    await this.platformAccess.assertPlatformAdmin(params.actorId);
    const application = await this.prisma.registrationApplication.findFirst({
      where: {
        id: params.applicationId,
        type: "new_org",
        status: "pending",
      },
    });
    if (!application) {
      throw new NotFoundException("Registration application not found");
    }
    if (!application.requestedOrgName || !application.requestedOrgSlug) {
      throw new BadRequestException("Organization details are incomplete");
    }

    // Optimistic claim FIRST: only transition from pending so two concurrent
    // approvals cannot both succeed (and cannot both create an org + invite).
    const claimed = await this.prisma.registrationApplication.updateMany({
      where: { id: application.id, status: "pending" },
      data: {
        status: "approved",
        reviewedById: params.actorId,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        "Registration application was already reviewed",
      );
    }

    let org;
    try {
      org = await this.orgService.createOrg(params.actorId, {
        name: application.requestedOrgName,
        slug: application.requestedOrgSlug,
        description: application.requestedDescription ?? undefined,
      });
    } catch (error) {
      // Compensation: release the claim so the platform admin can retry.
      await this.prisma.registrationApplication
        .updateMany({
          where: { id: application.id, status: "approved", generatedInviteId: null },
          data: { status: "pending" },
        })
        .catch(() => undefined);
      throw error;
    }

    const adminRole = await this.prisma.role.findFirst({
      where: {
        orgId: org.id,
        name: "admin",
      },
    });
    if (!adminRole) {
      throw new NotFoundException("Admin role not found for approved organization");
    }

    const invite = await this.inviteService.createInvite(
      org.id,
      params.actorId,
      {
        email: application.email,
        firstName: application.firstName,
        lastName: application.lastName,
        primaryRoleId: adminRole.id,
        roleIds: [adminRole.id],
      },
      params.baseUrl,
    );

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: org.id,
          actorId: params.actorId,
          resource: "org",
          action: "registration_application_approved",
          metadata: {
            applicationId: application.id,
            inviteId: invite.id,
          },
        },
      },
      {
        orgId: org.id,
        actorId: params.actorId,
        resource: "org",
        action: "registration_application_approved",
      },
    );

    await this.prisma.registrationApplication.update({
      where: { id: application.id },
      data: { generatedInviteId: invite.id },
    });

    return this.prisma.registrationApplication.findUnique({
      where: { id: application.id },
    });
  }

  async rejectNewOrgApplication(params: {
    actorId: string;
    applicationId: string;
    reason?: string;
  }) {
    await this.platformAccess.assertPlatformAdmin(params.actorId);
    const application = await this.prisma.registrationApplication.findFirst({
      where: {
        id: params.applicationId,
        type: "new_org",
        status: "pending",
      },
    });
    if (!application) {
      throw new NotFoundException("Registration application not found");
    }

    const updated = await this.prisma.registrationApplication.update({
      where: { id: application.id },
      data: {
        status: "rejected",
        decisionReason: params.reason?.trim() || null,
        reviewedById: params.actorId,
        reviewedAt: new Date(),
      },
    });
    await this.emailService.send({
      to: updated.email,
      subject: "Organization application update",
      text: "Your organization registration request was not approved.",
      html: "<p>Your organization registration request was not approved.</p>",
    });

    return updated;
  }

  private async assertOrgAdmin(actorId: string, orgId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          userId: actorId,
          orgId,
        },
      },
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
      },
    });
    if (!membership) {
      throw new ForbiddenException("Organization admin access required");
    }

    // Permission-based (matches the controller guard) instead of role-name
    // based: the default "manager" role carries users.write but is not named
    // "admin", so a name check would deadlock it with a 403.
    if (!hasMembershipPermission(membership, "users.write")) {
      throw new ForbiddenException("Organization admin access required");
    }
  }
}

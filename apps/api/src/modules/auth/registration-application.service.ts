import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

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
    return this.prisma.registrationApplication.create({
      data: {
        type: "new_org",
        email: normalizeEmailAddress(input.email),
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        requestedOrgName: input.orgName.trim(),
        requestedOrgSlug: input.orgSlug.trim().toLowerCase(),
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
    return this.prisma.registrationApplication.create({
      data: {
        type: "join_org",
        email: normalizeEmailAddress(input.email),
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

    const invite = await this.inviteService.createInvite(
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

    return this.prisma.registrationApplication.update({
      where: { id: application.id },
      data: {
        status: "approved",
        reviewedById: params.actorId,
        reviewedAt: new Date(),
        generatedInviteId: invite.id,
      },
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

    const org = await this.orgService.createOrg(params.actorId, {
      name: application.requestedOrgName,
      slug: application.requestedOrgSlug,
      description: application.requestedDescription ?? undefined,
    });
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

    return this.prisma.registrationApplication.update({
      where: { id: application.id },
      data: {
        status: "approved",
        reviewedById: params.actorId,
        reviewedAt: new Date(),
        generatedInviteId: invite.id,
      },
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
}

import { ForbiddenException, Injectable } from "@nestjs/common";

import { PrismaService } from "../config/prisma.service";

const PLATFORM_ADMIN_ROLE = "platform_admin";

@Injectable()
export class PlatformAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getGlobalRoles(userId: string) {
    const assignments = await this.prisma.globalRoleAssignment.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return assignments.map((assignment) => assignment.role);
  }

  async isPlatformAdmin(userId: string) {
    const assignment = await this.prisma.globalRoleAssignment.findFirst({
      where: {
        userId,
        role: PLATFORM_ADMIN_ROLE,
      },
      select: { id: true },
    });

    return Boolean(assignment);
  }

  async assertPlatformAdmin(userId: string) {
    if (!(await this.isPlatformAdmin(userId))) {
      throw new ForbiddenException("Platform admin access required");
    }
  }
}

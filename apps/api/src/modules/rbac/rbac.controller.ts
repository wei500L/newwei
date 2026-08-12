import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { AssignRoleDto } from "./dto/assign-role.dto";
import { CreateRoleDto } from "./dto/create-role.dto";
import { RbacService } from "./rbac.service";

@ApiTags("rbac")
@ApiBearerAuth()
@Controller("rbac")
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  @Permissions("permissions.read")
  @Get("permissions")
  async permissions() {
    return this.rbacService.listPermissions();
  }

  @Permissions("roles.read")
  @Get("roles")
  async roles(@CurrentUser() user: AuthenticatedUser, @Query("includeSystem") includeSystem?: string) {
    const includeSystemFlag = includeSystem === undefined ? true : includeSystem === "true";
    return this.rbacService.listRoles(user.orgId, { includeSystem: includeSystemFlag });
  }

  @Permissions("roles.write")
  @Post("roles")
  async createRole(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRoleDto) {
    return this.rbacService.createRole(user.orgId, user.id, body);
  }

  @Permissions("roles.write")
  @Post("assign")
  async assignRole(@CurrentUser() user: AuthenticatedUser, @Body() body: AssignRoleDto) {
    return this.rbacService.assignRole(user.orgId, user.id, body);
  }

  @Permissions("users.read")
  @Get("members")
  async members(@CurrentUser() user: AuthenticatedUser) {
    return this.rbacService.listMembers(user.orgId);
  }

  @Permissions("settings.manage")
  @Get("audit-logs")
  async auditLogs(@CurrentUser() user: AuthenticatedUser, @Query("limit") limit?: string) {
    // Audit records expose actor/ip/metadata; require the same privilege as
    // the admin audit-log endpoint instead of the org.read default that even
    // analysts hold.
    const parsedLimit = Number(limit);
    const safeLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.trunc(parsedLimit), 200)
        : 20;
    return this.rbacService.auditLogs(user.orgId, safeLimit);
  }
}

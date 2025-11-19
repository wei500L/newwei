import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { RbacService } from "./rbac.service";
import { CreateRoleDto } from "./dto/create-role.dto";
import { AssignRoleDto } from "./dto/assign-role.dto";

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
  async roles(@CurrentUser() user: AuthenticatedUser) {
    return this.rbacService.listRoles(user.orgId);
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

  @Permissions("org.read")
  @Get("audit-logs")
  async auditLogs(@CurrentUser() user: AuthenticatedUser, @Query("limit") limit?: string) {
    return this.rbacService.auditLogs(user.orgId, limit ? Number(limit) : 20);
  }
}

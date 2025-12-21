import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { AuditLogSettingsService } from "./audit-log-settings.service";
import { UpdateAuditLogRetentionDto } from "./dto/audit-log-settings.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/audit-log")
export class AuditLogSettingsController {
  constructor(private readonly auditLogSettings: AuditLogSettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async getRetention() {
    const retentionDays = await this.auditLogSettings.getRetentionDays();
    return { retentionDays };
  }

  @Put()
  @Permissions("settings.manage")
  async updateRetention(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateAuditLogRetentionDto
  ) {
    const retentionDays = await this.auditLogSettings.updateRetentionDays(
      user.orgId,
      user.id,
      body.retentionDays
    );
    return { retentionDays };
  }
}

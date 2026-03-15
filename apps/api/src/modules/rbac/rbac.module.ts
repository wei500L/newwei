import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { DatabaseModule } from "../config/database.module";

import { AuditLogRetentionService } from "./audit-log-retention.service";
import { RbacController } from "./rbac.controller";
import { RbacService } from "./rbac.service";
import { UserAdminService } from "./user-admin.service";

const scheduleEnabled = process.env.SCHEDULE_ENABLED !== "false";

@Module({
  imports: [DatabaseModule, ...(scheduleEnabled ? [ScheduleModule] : [])],
  controllers: [RbacController],
  providers: [RbacService, AuditLogRetentionService, UserAdminService],
  exports: [RbacService, UserAdminService]
})
export class RbacModule {}

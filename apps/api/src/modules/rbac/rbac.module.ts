import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { DatabaseModule } from "../config/database.module";

import { AuditLogRetentionService } from "./audit-log-retention.service";
import { RbacController } from "./rbac.controller";
import { RbacService } from "./rbac.service";

@Module({
  imports: [DatabaseModule, ScheduleModule],
  controllers: [RbacController],
  providers: [RbacService, AuditLogRetentionService],
  exports: [RbacService]
})
export class RbacModule {}

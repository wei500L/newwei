import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { RbacController } from "./rbac.controller";
import { RbacService } from "./rbac.service";
import { DatabaseModule } from "../config/database.module";
import { AuditLogRetentionService } from "./audit-log-retention.service";

@Module({
  imports: [DatabaseModule, ScheduleModule],
  controllers: [RbacController],
  providers: [RbacService, AuditLogRetentionService],
  exports: [RbacService]
})
export class RbacModule {}

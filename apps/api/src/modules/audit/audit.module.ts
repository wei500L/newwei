import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { DatabaseModule } from "../config/database.module";
import { AuditLogOutboxService } from "./audit-log-outbox.service";

@Module({
  imports: [DatabaseModule, ScheduleModule],
  providers: [AuditLogOutboxService]
})
export class AuditModule {}


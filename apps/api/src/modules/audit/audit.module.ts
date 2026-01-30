import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { DatabaseModule } from "../config/database.module";

import { AuditLogOutboxService } from "./audit-log-outbox.service";

const scheduleEnabled = process.env.SCHEDULE_ENABLED !== "false";

@Module({
  imports: [DatabaseModule, ...(scheduleEnabled ? [ScheduleModule] : [])],
  providers: [AuditLogOutboxService]
})
export class AuditModule {}

import { Global, Module } from "@nestjs/common";

import { MultiTenantSchedulerSettingsController } from "./multi-tenant-scheduler-settings.controller";
import { MultiTenantSchedulerSettingsService } from "./multi-tenant-scheduler-settings.service";

@Global()
@Module({
  controllers: [MultiTenantSchedulerSettingsController],
  providers: [MultiTenantSchedulerSettingsService],
  exports: [MultiTenantSchedulerSettingsService],
})
export class MultiTenantSchedulerSettingsModule {}

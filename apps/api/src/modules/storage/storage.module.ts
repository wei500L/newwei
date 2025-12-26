import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../config/database.module";

import { StorageService } from "./storage.service";
import { StorageSettingsController } from "./storage-settings.controller";
import { StorageSettingsService } from "./storage-settings.service";

@Module({
  imports: [ConfigModule, CacheModule, DatabaseModule],
  controllers: [StorageSettingsController],
  providers: [StorageService, StorageSettingsService],
  exports: [StorageService, StorageSettingsService]
})
export class StorageModule {}

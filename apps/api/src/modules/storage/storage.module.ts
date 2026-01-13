import { Module } from "@nestjs/common";

import { CacheModule } from "../cache/cache.module";
import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../config/database.module";

import { StorageSettingsController } from "./storage-settings.controller";
import { StorageSettingsService } from "./storage-settings.service";
import { StorageService } from "./storage.service";

@Module({
  imports: [ConfigModule, CacheModule, DatabaseModule],
  controllers: [StorageSettingsController],
  providers: [StorageService, StorageSettingsService],
  exports: [StorageService, StorageSettingsService]
})
export class StorageModule {}

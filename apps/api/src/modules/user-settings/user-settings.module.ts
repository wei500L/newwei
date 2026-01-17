import { Module } from "@nestjs/common";

import { UserUiSettingsController } from "./user-ui-settings.controller";
import { UserSettingsService } from "./user-settings.service";

@Module({
  controllers: [UserUiSettingsController],
  providers: [UserSettingsService],
  exports: [UserSettingsService]
})
export class UserSettingsModule {}


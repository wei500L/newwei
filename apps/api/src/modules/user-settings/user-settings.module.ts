import { Module } from "@nestjs/common";

import { UserSettingsService } from "./user-settings.service";
import { UserUiSettingsController } from "./user-ui-settings.controller";

@Module({
  controllers: [UserUiSettingsController],
  providers: [UserSettingsService],
  exports: [UserSettingsService]
})
export class UserSettingsModule {}


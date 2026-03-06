import { Module } from "@nestjs/common";

import { UserContentSubscriptionsModule } from "../user-content-subscriptions/user-content-subscriptions.module";

import { UserDigestController } from "./user-digest.controller";
import { UserDigestService } from "./user-digest.service";

@Module({
  imports: [UserContentSubscriptionsModule],
  controllers: [UserDigestController],
  providers: [UserDigestService],
  exports: [UserDigestService]
})
export class UserDigestModule {}

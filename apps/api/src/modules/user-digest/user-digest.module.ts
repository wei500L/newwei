import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module";
import { UserContentSubscriptionsModule } from "../user-content-subscriptions/user-content-subscriptions.module";

import { UserDigestDeliverySchedulerService } from "./user-digest-delivery-scheduler.service";
import { UserDigestDeliveryService } from "./user-digest-delivery.service";
import { UserDigestController } from "./user-digest.controller";
import { UserDigestService } from "./user-digest.service";

@Module({
  imports: [UserContentSubscriptionsModule, NotificationsModule],
  controllers: [UserDigestController],
  providers: [
    UserDigestService,
    UserDigestDeliveryService,
    UserDigestDeliverySchedulerService,
  ],
  exports: [UserDigestService, UserDigestDeliveryService],
})
export class UserDigestModule {}

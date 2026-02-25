import { Module } from "@nestjs/common";

import { UserNewsBehaviorController } from "./user-news-behavior.controller";
import { UserNewsBehaviorService } from "./user-news-behavior.service";

@Module({
  controllers: [UserNewsBehaviorController],
  providers: [UserNewsBehaviorService],
  exports: [UserNewsBehaviorService],
})
export class UserNewsBehaviorModule {}

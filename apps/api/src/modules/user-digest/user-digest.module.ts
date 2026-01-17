import { Module } from "@nestjs/common";

import { UserDigestController } from "./user-digest.controller";
import { UserDigestService } from "./user-digest.service";

@Module({
  controllers: [UserDigestController],
  providers: [UserDigestService],
  exports: [UserDigestService]
})
export class UserDigestModule {}


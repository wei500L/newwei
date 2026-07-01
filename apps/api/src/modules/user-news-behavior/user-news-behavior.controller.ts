import { Body, Controller, Delete, Get, Post } from "@nestjs/common";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import {
  RecordUserNewsBehaviorDto,
  validateRecordUserNewsBehaviorDto,
} from "./dto/record-user-news-behavior.dto";
import { UserNewsBehaviorService } from "./user-news-behavior.service";

@Controller("user-news-behavior")
export class UserNewsBehaviorController {
  constructor(private readonly behavior: UserNewsBehaviorService) {}

  @Post()
  @Permissions("items.read")
  async record(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RecordUserNewsBehaviorDto,
  ) {
    validateRecordUserNewsBehaviorDto(body);
    return this.behavior.record({
      orgId: user.orgId,
      userId: user.id,
      type: body.type,
      itemId: body.itemId,
      eventId: body.eventId,
      source: body.source,
      topics: body.topics,
      entities: body.entities,
      url: body.url,
    });
  }

  @Get("profile")
  @Permissions("items.read")
  async profile(@CurrentUser() user: AuthenticatedUser) {
    return this.behavior.getProfile(user.orgId, user.id);
  }

  @Delete("profile")
  @Permissions("items.read")
  async clearProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.behavior.clearProfile(user.orgId, user.id);
  }
}

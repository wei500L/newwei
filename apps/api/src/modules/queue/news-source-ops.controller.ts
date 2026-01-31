import { Controller, Param, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { resolveRequestIp } from "../../common/request-ip";
import type { AuthenticatedUser } from "../auth/auth.service";

import { NewsSourceSchedulerService } from "./news-source.scheduler.service";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/news-sources")
export class NewsSourceOpsController {
  constructor(private readonly scheduler: NewsSourceSchedulerService) {}

  @Post(":id/cancel-queued")
  @Permissions("crawl.write")
  async cancelQueued(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.scheduler.cancelQueuedCrawls(user.orgId, id, user.id);
  }

  @Post(":id/clear-inflight")
  @Permissions("crawl.write")
  async clearInflight(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.scheduler.clearInFlight(user.orgId, id);
  }

  @Post(":id/retry-latest")
  @Permissions("crawl.write")
  async retryLatest(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    return this.scheduler.retryLatestFailedTask(
      user.orgId,
      id,
      user.id,
      resolveRequestIp(req),
      user.permissions
    );
  }
}

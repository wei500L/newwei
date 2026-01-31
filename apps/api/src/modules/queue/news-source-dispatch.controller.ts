import { ConflictException, Controller, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { NewsSourceSchedulerService } from "./news-source.scheduler.service";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/news-sources")
export class NewsSourceDispatchController {
  constructor(private readonly scheduler: NewsSourceSchedulerService) {}

  @Post(":id/dispatch")
  @Permissions("crawl.write")
  async dispatch(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const result = await this.scheduler.dispatchNow(user.orgId, id, user.id);
    if (!result) {
      throw new ConflictException("News source is already being dispatched");
    }
    return result;
  }
}


import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { RealtimeSignalsService } from "./realtime-signals.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/realtime-signals")
export class RealtimeSignalsRuntimeController {
  constructor(private readonly realtimeSignals: RealtimeSignalsService) {}

  @Get("runtime")
  @Permissions("settings.manage")
  async getRuntimeDiagnostics(@CurrentUser() user: AuthenticatedUser) {
    return this.realtimeSignals.getRuntimeDiagnostics(user.orgId);
  }
}

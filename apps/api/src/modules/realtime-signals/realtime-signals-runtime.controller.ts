import { Controller, Get } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { RealtimeSignalsRuntimeDiagnosticsResponseDto } from "../system-settings/dto/realtime-signals-runtime.dto";

import { RealtimeSignalsService } from "./realtime-signals.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/realtime-signals")
export class RealtimeSignalsRuntimeController {
  constructor(private readonly realtimeSignals: RealtimeSignalsService) {}

  @Get("runtime")
  @Permissions("settings.manage")
  @ApiOperation({
    summary: "Get realtime signals runtime diagnostics",
    description:
      "Returns the effective runtime status, structured source diagnostics, upstream error codes, and marker readiness for realtime signals.",
  })
  @ApiOkResponse({ type: RealtimeSignalsRuntimeDiagnosticsResponseDto })
  async getRuntimeDiagnostics(@CurrentUser() user: AuthenticatedUser) {
    return this.realtimeSignals.getRuntimeDiagnostics(user.orgId);
  }
}

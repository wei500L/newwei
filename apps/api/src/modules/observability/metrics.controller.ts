import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { MachineTokenService } from "../auth/machine-token.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import {
  prometheusContentType,
  renderPrometheusMetrics,
} from "./prometheus-metrics";

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return undefined;
  }
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

@ApiTags("metrics")
@ApiBearerAuth()
@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly platformAccess: PlatformAccessService,
    private readonly machineTokens: MachineTokenService,
  ) {}

  @Get()
  @Permissions("metrics.read")
  @Header("Content-Type", prometheusContentType())
  async scrape(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<string> {
    // SEC-03：/api/metrics 是进程级与跨组织聚合，不是组织指标。
    // metrics.read 仍然必需（PermissionsGuard），但不够。人类走现有
    // platformAccess.assertPlatformAdmin(user.id)。机器令牌另查库：
    // 创建者当前是否为平台管理员。不按令牌前缀或声明提升权限。
    const decision = await this.machineTokens.resolvePlatformMetricsAccess(
      bearerToken(req),
    );
    if (decision === "machine-denied") {
      throw new ForbiddenException("Platform admin access required");
    }
    if (decision !== "machine-allowed") {
      await this.platformAccess.assertPlatformAdmin(user.id);
    }
    return renderPrometheusMetrics();
  }
}

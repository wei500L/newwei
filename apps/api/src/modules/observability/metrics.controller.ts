import { Controller, Get, Header } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { Permissions } from "../../common/decorators/permissions.decorator";

import {
  prometheusContentType,
  renderPrometheusMetrics,
} from "./prometheus-metrics";

@ApiTags("metrics")
@ApiBearerAuth()
@Controller("metrics")
export class MetricsController {
  @Get()
  @Permissions("metrics.read")
  @Header("Content-Type", prometheusContentType())
  async scrape(): Promise<string> {
    return renderPrometheusMetrics();
  }
}

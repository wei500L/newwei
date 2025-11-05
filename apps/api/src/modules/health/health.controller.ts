import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { Public } from "../../common/decorators/public.decorator";
import pkg from "../../package.json" assert { type: "json" };

@Controller("healthz")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async getHealth() {
    await this.prisma.$queryRaw`SELECT 1`;
    return {
      ok: true,
      version: pkg.version ?? "0.0.0",
      now: new Date().toISOString()
    };
  }
}

import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { DatabaseModule } from "../config/database.module";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController]
})
export class HealthModule {}

import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";

import { EnvService } from "../config/config.service";

import { ModelServiceClient } from "./model-service.client";

@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        timeout: env.modelServiceConfig.timeoutMs
      })
    })
  ],
  providers: [ModelServiceClient],
  exports: [ModelServiceClient]
})
export class ModelServiceModule {}


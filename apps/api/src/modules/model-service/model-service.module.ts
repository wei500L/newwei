import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";

import { withKeepAliveAgents } from "../../common/http/http-agent";
import { EnvService } from "../config/config.service";

import { ModelServiceClient } from "./model-service.client";

@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) =>
        withKeepAliveAgents(
          {
            timeout: env.modelServiceConfig.timeoutMs
          },
          env.httpAgentConfig
        )
    })
  ],
  providers: [ModelServiceClient],
  exports: [ModelServiceClient]
})
export class ModelServiceModule {}

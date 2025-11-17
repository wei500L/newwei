import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";
import { DatabaseModule } from "../config/database.module";
import { EnvService } from "../config/config.service";
import { EmailModule } from "../email/email.module";
import { ALERTS_QUEUE, ALERTS_QUEUE_EVENTS, ALERTS_QUEUE_NAME } from "./alerts.constants";
import { AlertsService } from "./alerts.service";
import { AlertsProcessor } from "./alerts.processor";
import { ALERTS_PUBSUB, createAlertsPubSub } from "./alerts.pubsub";

@Module({
  imports: [
    DatabaseModule,
    EmailModule,
    HttpModule.registerAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        timeout: env.alertingConfig.webhookTimeoutMs
      })
    })
  ],
  providers: [
    AlertsService,
    AlertsProcessor,
    {
      provide: ALERTS_QUEUE,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        return new Queue(ALERTS_QUEUE_NAME, {
          connection: env.redisConfig
        });
      }
    },
    {
      provide: ALERTS_QUEUE_EVENTS,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        return new QueueEvents(ALERTS_QUEUE_NAME, {
          connection: env.redisConfig
        });
      }
    },
    {
      provide: ALERTS_PUBSUB,
      useFactory: () => createAlertsPubSub()
    }
  ],
  exports: [AlertsService]
})
export class AlertsModule {}

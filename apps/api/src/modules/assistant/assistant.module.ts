import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { EnvService } from "../config/config.service";
import { ItemsModule } from "../items/items.module";
import { ModelServiceModule } from "../model-service/model-service.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { AssistantPromptService } from "./assistant-prompt.service";
import { AssistantQueueEventPublisher } from "./assistant-queue-event.publisher";
import { AssistantQueueCleanupService } from "./assistant-queue-cleanup.service";
import { ASSISTANT_QUEUE, ASSISTANT_QUEUE_EVENTS, ASSISTANT_QUEUE_NAME } from "./assistant.constants";
import { AssistantProcessor } from "./assistant.processor";
import { ASSISTANT_PUBSUB, createAssistantPubSub } from "./assistant.pubsub";
import { AssistantService } from "./assistant.service";
import type { AssistantJobPayload } from "./assistant.types";

@Module({
  imports: [NewsPipelineModule, ItemsModule, ModelServiceModule],
  providers: [
    AssistantService,
    AssistantPromptService,
    AssistantQueueEventPublisher,
    AssistantProcessor,
    AssistantQueueCleanupService,
    {
      provide: ASSISTANT_QUEUE,
      inject: [EnvService, AssistantQueueCleanupService],
      useFactory: (env: EnvService, cleanup: AssistantQueueCleanupService) => {
        const queue = new Queue<AssistantJobPayload>(ASSISTANT_QUEUE_NAME, { connection: env.redisConfig });
        cleanup.track(queue);
        return queue;
      }
    },
    {
      provide: ASSISTANT_QUEUE_EVENTS,
      inject: [EnvService, AssistantQueueCleanupService],
      useFactory: (env: EnvService, cleanup: AssistantQueueCleanupService) => {
        const events = new QueueEvents(ASSISTANT_QUEUE_NAME, { connection: env.redisConfig });
        cleanup.track(events);
        return events;
      }
    },
    {
      provide: ASSISTANT_PUBSUB,
      useFactory: () => createAssistantPubSub()
    },
    {
      provide: getQueueToken(ASSISTANT_QUEUE_NAME),
      useExisting: ASSISTANT_QUEUE
    }
  ],
  exports: [
    AssistantService,
    AssistantQueueEventPublisher,
    ASSISTANT_QUEUE,
    ASSISTANT_QUEUE_EVENTS,
    ASSISTANT_PUBSUB,
    getQueueToken(ASSISTANT_QUEUE_NAME)
  ]
})
export class AssistantModule {}

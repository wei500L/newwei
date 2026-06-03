import { getQueueToken } from "@nestjs/bull-shared";
import { Module } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";

import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";
import { BullmqConnectionService } from "../config/bullmq-connection.service";
import { ItemsModule } from "../items/items.module";
import { ModelServiceModule } from "../model-service/model-service.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { AssistantPromptService } from "./assistant-prompt.service";
import { AssistantQueueCleanupService } from "./assistant-queue-cleanup.service";
import { AssistantQueueEventPublisher } from "./assistant-queue-event.publisher";
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
      inject: [AssistantQueueCleanupService, BullmqConnectionService],
      useFactory: (
        cleanup: AssistantQueueCleanupService,
        bullmqConnections: BullmqConnectionService,
      ) => {
        const queue = new Queue<AssistantJobPayload>(ASSISTANT_QUEUE_NAME, {
          connection: bullmqConnections.getSharedConnection(),
          defaultJobOptions: {
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
          },
        });
        cleanup.track(queue);
        return queue;
      }
    },
    {
      provide: ASSISTANT_QUEUE_EVENTS,
      inject: [AssistantQueueCleanupService, BullmqConnectionService],
      useFactory: (
        cleanup: AssistantQueueCleanupService,
        bullmqConnections: BullmqConnectionService,
      ) => {
        const events = new QueueEvents(ASSISTANT_QUEUE_NAME, {
          connection: bullmqConnections.createDedicatedConnectionOptions(
            `events:${ASSISTANT_QUEUE_NAME}`,
          ),
        });
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

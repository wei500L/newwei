import { Injectable } from "@nestjs/common";

import { BullmqQueueCleanupService } from "../../common/bullmq-queue-cleanup.service";

@Injectable()
export class AssistantQueueCleanupService extends BullmqQueueCleanupService {}

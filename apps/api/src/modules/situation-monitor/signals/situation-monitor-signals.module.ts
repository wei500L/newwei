import { getQueueToken } from '@nestjs/bull-shared';
import { Module } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';

import { BULLMQ_FAILED_JOB_RETENTION } from '../../../common/bullmq-retention';
import { AlertsModule } from '../../alerts/alerts.module';
import { AuthModule } from '../../auth/auth.module';
import { EnvService } from '../../config/config.service';
import { toBullmqConnection } from '../../config/redis-connection';

import { SituationMonitorSignalsQueueCleanupService } from './situation-monitor-signals-queue-cleanup.service';
import {
  SITUATION_MONITOR_SIGNALS_QUEUE,
  SITUATION_MONITOR_SIGNALS_QUEUE_EVENTS,
  SITUATION_MONITOR_SIGNALS_QUEUE_NAME,
} from './situation-monitor-signals.constants';
import { SituationMonitorSignalsDispatcher } from './situation-monitor-signals.dispatcher';
import { SituationMonitorSignalsGateway } from './situation-monitor-signals.gateway';
import { SituationMonitorSignalsProcessor } from './situation-monitor-signals.processor';
import { SituationMonitorSignalsService } from './situation-monitor-signals.service';

@Module({
  imports: [AuthModule, AlertsModule],
  providers: [
    SituationMonitorSignalsService,
    SituationMonitorSignalsDispatcher,
    SituationMonitorSignalsProcessor,
    SituationMonitorSignalsGateway,
    SituationMonitorSignalsQueueCleanupService,
    {
      provide: SITUATION_MONITOR_SIGNALS_QUEUE,
      inject: [EnvService, SituationMonitorSignalsQueueCleanupService],
      useFactory: (
        env: EnvService,
        cleanup: SituationMonitorSignalsQueueCleanupService,
      ) => {
        const queue = new Queue(SITUATION_MONITOR_SIGNALS_QUEUE_NAME, {
          connection: toBullmqConnection(env.redisConfig),
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 1_000,
            },
          },
        });
        cleanup.track(queue);
        return queue;
      },
    },
    {
      provide: SITUATION_MONITOR_SIGNALS_QUEUE_EVENTS,
      inject: [EnvService, SituationMonitorSignalsQueueCleanupService],
      useFactory: (
        env: EnvService,
        cleanup: SituationMonitorSignalsQueueCleanupService,
      ) => {
        const events = new QueueEvents(SITUATION_MONITOR_SIGNALS_QUEUE_NAME, {
          connection: toBullmqConnection(env.redisConfig),
        });
        cleanup.track(events);
        return events;
      },
    },
    {
      provide: getQueueToken(SITUATION_MONITOR_SIGNALS_QUEUE_NAME),
      useExisting: SITUATION_MONITOR_SIGNALS_QUEUE,
    },
  ],
  exports: [
    SituationMonitorSignalsService,
    SituationMonitorSignalsDispatcher,
    SITUATION_MONITOR_SIGNALS_QUEUE,
    SITUATION_MONITOR_SIGNALS_QUEUE_EVENTS,
    getQueueToken(SITUATION_MONITOR_SIGNALS_QUEUE_NAME),
  ],
})
export class SituationMonitorSignalsModule {}

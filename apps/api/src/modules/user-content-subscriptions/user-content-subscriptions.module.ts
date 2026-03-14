import { Module } from '@nestjs/common';

import { NewsPipelineModule } from '../news-pipeline/news-pipeline.module';
import { SituationMonitorModule } from '../situation-monitor/situation-monitor.module';
import { UserNewsBehaviorModule } from '../user-news-behavior/user-news-behavior.module';

import { UserContentSubscriptionsController } from './user-content-subscriptions.controller';
import { UserContentSubscriptionsService } from './user-content-subscriptions.service';

@Module({
  imports: [NewsPipelineModule, SituationMonitorModule, UserNewsBehaviorModule],
  controllers: [UserContentSubscriptionsController],
  providers: [UserContentSubscriptionsService],
  exports: [UserContentSubscriptionsService],
})
export class UserContentSubscriptionsModule {}

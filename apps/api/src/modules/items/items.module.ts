import { Module } from "@nestjs/common";

import { DatabaseModule } from "../config/database.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { QueueModule } from "../queue/queue.module";

import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";

@Module({
  imports: [DatabaseModule, QueueModule, NewsPipelineModule],
  providers: [ItemsService],
  controllers: [ItemsController],
  exports: [ItemsService]
})
export class ItemsModule {}

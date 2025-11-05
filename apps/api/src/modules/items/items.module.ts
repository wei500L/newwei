import { Module } from "@nestjs/common";
import { ItemsService } from "./items.service";
import { ItemsController } from "./items.controller";
import { DatabaseModule } from "../config/database.module";
import { QueueModule } from "../queue/queue.module";

@Module({
  imports: [DatabaseModule, QueueModule],
  providers: [ItemsService],
  controllers: [ItemsController],
  exports: [ItemsService]
})
export class ItemsModule {}

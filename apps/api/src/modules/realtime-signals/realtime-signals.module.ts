import { Module } from "@nestjs/common";

import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../config/database.module";

import { RealtimeSignalsRuntimeController } from "./realtime-signals-runtime.controller";
import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";
import { RealtimeSignalsService } from "./realtime-signals.service";

@Module({
  imports: [DatabaseModule, CacheModule],
  controllers: [RealtimeSignalsRuntimeController],
  providers: [RealtimeSignalsSnapshotStore, RealtimeSignalsService],
  exports: [RealtimeSignalsSnapshotStore, RealtimeSignalsService],
})
export class RealtimeSignalsModule {}

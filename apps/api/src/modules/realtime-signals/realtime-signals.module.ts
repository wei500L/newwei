import { Module } from "@nestjs/common";

import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../config/database.module";

import { RealtimeAdsbService } from "./realtime-adsb.service";
import { RealtimeAisService } from "./realtime-ais.service";
import { RealtimeKeywordPolymarketService } from "./realtime-keyword-polymarket.service";
import { RealtimeOpenskyService } from "./realtime-opensky.service";
import { RealtimeSignalsRuntimeController } from "./realtime-signals-runtime.controller";
import { RealtimeSignalsService } from "./realtime-signals.service";
import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";
import { RealtimeTransportPersistenceService } from "./realtime-transport-persistence.service";
import { RealtimeUnrestOutageService } from "./realtime-unrest-outage.service";

@Module({
  imports: [DatabaseModule, CacheModule],
  controllers: [RealtimeSignalsRuntimeController],
  providers: [
    RealtimeSignalsSnapshotStore,
    RealtimeTransportPersistenceService,
    RealtimeOpenskyService,
    RealtimeAdsbService,
    RealtimeAisService,
    RealtimeUnrestOutageService,
    RealtimeKeywordPolymarketService,
    RealtimeSignalsService,
  ],
  exports: [RealtimeSignalsSnapshotStore, RealtimeSignalsService],
})
export class RealtimeSignalsModule {}

import { Module } from "@nestjs/common";

import { SentimentSnapshotIngestionService } from "./sentiment-snapshot.ingestion.service";
import { SentimentService } from "./sentiment.service";

@Module({
  providers: [SentimentService, SentimentSnapshotIngestionService],
  exports: [SentimentService]
})
export class SentimentModule {}


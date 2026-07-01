import { Module } from "@nestjs/common";

import { ArchiveModule } from "../archive/archive.module";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../config/database.module";
import { ItemsModule } from "../items/items.module";
import { NewsEventsModule } from "../news-events/news-events.module";

import { AnalysisWorkspaceController } from "./analysis-workspace.controller";
import { AnalysisWorkspaceService } from "./analysis-workspace.service";

@Module({
  imports: [DatabaseModule, AuthModule, ItemsModule, NewsEventsModule, ArchiveModule],
  controllers: [AnalysisWorkspaceController],
  providers: [AnalysisWorkspaceService],
})
export class AnalysisWorkspaceModule {}

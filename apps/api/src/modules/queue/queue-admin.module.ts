import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { Module } from "@nestjs/common";
import type { RequestHandler } from "express";

import { AKSHARE_QUEUE_NAME } from "../akshare/akshare.constants";
import { AkshareModule } from "../akshare/akshare.module";
import { ALERTS_QUEUE_NAME } from "../alerts/alerts.constants";
import { AlertsModule } from "../alerts/alerts.module";
import { ANALYSIS_QUEUE_NAME } from "../analysis/analysis.constants";
import { AnalysisModule } from "../analysis/analysis.module";
import { ASSISTANT_QUEUE_NAME } from "../assistant/assistant.constants";
import { AssistantModule } from "../assistant/assistant.module";
import { EnvService } from "../config/config.service";
import { CRAWL_QUEUE_NAME } from "../crawl/crawl.constants";
import { CrawlModule } from "../crawl/crawl.module";

import { ITEM_PIPELINE_DLQ_QUEUE_NAME, ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";
import { QueueModule } from "./queue.module";

const createBullBoardBasicAuthMiddleware = (
  username: string,
  password: string,
): RequestHandler => {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="queues"');
      res.status(401).send("Authentication required");
      return;
    }

    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const [incomingUser, ...passwordParts] = decoded.split(":");
    const incomingPass = passwordParts.join(":");
    if (incomingUser === username && incomingPass === password) {
      next();
      return;
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="queues"');
    res.status(401).send("Invalid credentials");
  };
};

@Module({
  imports: [
    QueueModule,
    CrawlModule,
    AkshareModule,
    AnalysisModule,
    AssistantModule,
    AlertsModule,
    BullBoardModule.forRootAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const { username, password } = env.bullBoardConfig;
        const middleware: RequestHandler[] = [];
        if (username && password) {
          middleware.push(createBullBoardBasicAuthMiddleware(username, password));
        }

        return {
          route: "/admin/queues",
          adapter: ExpressAdapter,
          middleware
        };
      }
    }),
    BullBoardModule.forFeature(
      { name: ITEM_PIPELINE_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ITEM_PIPELINE_DLQ_QUEUE_NAME, adapter: BullMQAdapter },
      { name: CRAWL_QUEUE_NAME, adapter: BullMQAdapter },
      { name: AKSHARE_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ANALYSIS_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ASSISTANT_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ALERTS_QUEUE_NAME, adapter: BullMQAdapter }
    )
  ]
})
export class QueueAdminModule {}

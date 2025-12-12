import { Module } from "@nestjs/common";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { RequestHandler } from "express";

import { CrawlModule } from "../crawl/crawl.module";
import { CRAWL_QUEUE_NAME } from "../crawl/crawl.constants";
import { AkshareModule } from "../akshare/akshare.module";
import { AKSHARE_QUEUE_NAME } from "../akshare/akshare.constants";
import { AnalysisModule } from "../analysis/analysis.module";
import { ANALYSIS_QUEUE_NAME } from "../analysis/analysis.constants";
import { AlertsModule } from "../alerts/alerts.module";
import { ALERTS_QUEUE_NAME } from "../alerts/alerts.constants";
import { EnvService } from "../config/config.service";

import { ITEM_PIPELINE_QUEUE_NAME, QueueModule } from "./queue.module";

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
      { name: CRAWL_QUEUE_NAME, adapter: BullMQAdapter },
      { name: AKSHARE_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ANALYSIS_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ALERTS_QUEUE_NAME, adapter: BullMQAdapter }
    )
  ]
})
export class QueueAdminModule {}

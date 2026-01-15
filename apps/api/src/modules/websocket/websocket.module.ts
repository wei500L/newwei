import { Global, Module } from "@nestjs/common";

import { UserSessionManager } from "./user-session-manager.service";
import { WsConnectionRateLimiterService } from "./ws-connection-rate-limiter.service";

@Global()
@Module({
  providers: [UserSessionManager, WsConnectionRateLimiterService],
  exports: [UserSessionManager, WsConnectionRateLimiterService]
})
export class WebSocketModule {}


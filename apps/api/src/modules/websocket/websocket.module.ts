import { Global, Module } from "@nestjs/common";

import { WebSocketAdapterRegistry } from "./websocket-adapter-registry.service";
import { UserSessionManager } from "./user-session-manager.service";
import { WsConnectionRateLimiterService } from "./ws-connection-rate-limiter.service";

@Global()
@Module({
  providers: [
    UserSessionManager,
    WsConnectionRateLimiterService,
    WebSocketAdapterRegistry,
  ],
  exports: [
    UserSessionManager,
    WsConnectionRateLimiterService,
    WebSocketAdapterRegistry,
  ]
})
export class WebSocketModule {}

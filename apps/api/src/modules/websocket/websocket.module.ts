import { Global, Module } from "@nestjs/common";

import { UserSessionManager } from "./user-session-manager.service";
import { WebSocketAdapterRegistry } from "./websocket-adapter-registry.service";
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

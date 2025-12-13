import { Global, Module } from "@nestjs/common";

import { UserSessionManager } from "./user-session-manager.service";

@Global()
@Module({
  providers: [UserSessionManager],
  exports: [UserSessionManager]
})
export class WebSocketModule {}


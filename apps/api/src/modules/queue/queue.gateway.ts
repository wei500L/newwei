import { createLogger } from "@modular/utils";
import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { verify } from "jsonwebtoken";
import { Server, Socket } from "socket.io";

import { AccessTokenBlacklistService } from "../auth/access-token-blacklist.service";
import { AuthService, AuthenticatedUser, JwtPayload } from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import { UserSessionManager } from "../websocket/user-session-manager.service";

import { QueueEventPayload, QueueEventPublisher } from "./queue-event.publisher";

@WebSocketGateway({
  namespace: "queue",
  cors: {
    origin: true,
    credentials: true,
  },
})
export class QueueGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = createLogger({ name: "queue-gateway" });
  private unsubscribe?: () => void;

  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly queueEvents: QueueEventPublisher,
    private readonly sessions: UserSessionManager,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.queueEvents.registerListener(async (orgId, payload) => {
      this.broadcast(orgId, payload);
    });
  }

  async onModuleDestroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  async handleConnection(client: Socket) {
    const ip = this.extractClientIp(client);
    try {
      if (!this.isOriginAllowed(this.extractOrigin(client))) {
        throw new Error("Origin not allowed");
      }

      const token = this.extractToken(client);
      const payload = this.verifyToken(token);
      await this.ensureNotRevoked(payload);
      const profile = await this.authService.getUserProfile(payload.sub, payload.orgId);
      if (!profile.permissions.includes("queue.manage")) {
        throw new Error("Insufficient permissions");
      }

      client.data.user = profile;
      client.data.clientIp = ip;

      const { userConnections } = await this.sessions.register(this.server, client, {
        userId: profile.id,
        orgId: profile.orgId,
        ip
      });
      client.emit("queue:connected", { orgId: profile.orgId, userId: profile.id });
      this.logger.info(
        { socketId: client.id, orgId: profile.orgId, userId: profile.id, ip, userConnections },
        "Queue socket connected"
      );
    } catch (error) {
      this.sessions.unregister(client);
      this.logger.warn(
        { socketId: client.id, ip, error: error instanceof Error ? error.message : String(error) },
        "Queue socket authentication failed",
      );
      const errorMessage = error instanceof Error ? error.message : String(error);
      const responseMessage = errorMessage === "Too many connections" ? "Too many connections" : "Unauthorized";
      client.emit("queue:error", { message: responseMessage });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const profile = client.data?.user as AuthenticatedUser | undefined;
    this.sessions.unregister(client);
    this.logger.info(
      { socketId: client.id, userId: profile?.id, orgId: profile?.orgId, ip: client.data?.clientIp },
      "Queue socket disconnected",
    );
  }

  private verifyToken(token: string): JwtPayload {
    const jwtConfig = this.env.jwtConfig;
    return verify(token, jwtConfig.secret, {
      audience: jwtConfig.audience,
      issuer: jwtConfig.issuer,
    }) as JwtPayload;
  }

  private async ensureNotRevoked(payload: JwtPayload) {
    if (payload.jti) {
      const revoked = await this.accessTokenBlacklist.has(payload.jti);
      if (revoked) {
        throw new Error("Token revoked");
      }
    }
  }

  private extractToken(client: Socket): string {
    const headerAuth = client.handshake.headers.authorization;
    const tokenFromHeader = this.parseAuthorizationHeader(headerAuth);
    if (tokenFromHeader) {
      return tokenFromHeader;
    }

    const authToken = client.handshake.auth?.token;
    if (typeof authToken === "string" && authToken.length > 0) {
      return authToken;
    }

    const queryToken = client.handshake.query?.token;
    if (typeof queryToken === "string" && queryToken.length > 0) {
      return queryToken;
    }
    if (Array.isArray(queryToken) && queryToken.length > 0 && typeof queryToken[0] === "string") {
      return queryToken[0];
    }

    throw new Error("Missing auth token");
  }

  private parseAuthorizationHeader(authHeader: string | string[] | undefined) {
    if (!authHeader) {
      return undefined;
    }
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const trimmed = headerValue.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      return trimmed.slice(7);
    }
    return undefined;
  }

  private extractOrigin(client: Socket) {
    const originHeader = client.handshake.headers.origin ?? client.handshake.headers.referer;
    const raw = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = new URL(raw);
      return parsed.origin;
    } catch {
      return raw;
    }
  }

  private isOriginAllowed(origin?: string | null) {
    if (!origin) {
      return true;
    }
    const corsConfig = this.env.graphqlConfig.corsOrigin;
    if (!corsConfig) {
      return true;
    }
    const allowed = corsConfig
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        try {
          return new URL(entry).origin;
        } catch {
          return entry;
        }
      });
    return allowed.length === 0 || allowed.includes(origin);
  }

  private broadcast(orgId: string, payload: QueueEventPayload) {
    if (!this.server) {
      return;
    }
    this.server.to(this.orgRoom(orgId)).emit("queue:event", { orgId, ...payload });
  }

  private orgRoom(orgId: string) {
    return `org:${orgId}`;
  }

  private extractClientIp(client: Socket) {
    const forwardedHeader = client.handshake.headers["x-forwarded-for"];
    const forwarded = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
    const ipFromForwarded = forwarded?.split(",")[0]?.trim();
    const address = typeof client.handshake.address === "string" ? client.handshake.address : undefined;
    const detectedIp = ipFromForwarded || address;
    return detectedIp ? detectedIp.replace(/^::ffff:/, "") : undefined;
  }
}

import { createLogger } from "@modular/utils";
import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from "@nestjs/websockets";
import { AccessTokenBlacklistService } from "../auth/access-token-blacklist.service";
import { AuthService, AuthenticatedUser, JwtPayload } from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import { NotificationDispatcher, NotificationEvent } from "./notification.dispatcher";
import { verify } from "jsonwebtoken";
import { Server, Socket } from "socket.io";

@WebSocketGateway({
  namespace: "notifications",
  cors: {
    origin: true,
    credentials: true
  }
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = createLogger({ name: "notifications-gateway" });
  private unsubscribe?: () => void;

  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly dispatcher: NotificationDispatcher
  ) {}

  onModuleInit() {
    this.unsubscribe = this.dispatcher.registerListener(async (event) => this.broadcast(event));
  }

  async onModuleDestroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  async handleConnection(client: Socket) {
    try {
      if (!this.isOriginAllowed(this.extractOrigin(client))) {
        throw new Error("Origin not allowed");
      }

      const token = this.extractToken(client);
      const payload = this.verifyToken(token);
      await this.ensureNotRevoked(payload);
      const profile = await this.authService.getUserProfile(payload.sub, payload.orgId);
      client.data.user = profile;
      await client.join([this.orgRoom(profile.orgId), this.userRoom(profile.id)]);
      client.emit("notification:connected", { orgId: profile.orgId, userId: profile.id });
      this.logger.info(
        { socketId: client.id, orgId: profile.orgId, userId: profile.id },
        "Notification socket connected"
      );
    } catch (error) {
      this.logger.warn(
        { socketId: client.id, error: error instanceof Error ? error.message : String(error) },
        "Notification socket authentication failed"
      );
      client.emit("notification:error", { message: "Unauthorized" });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const profile = client.data?.user as AuthenticatedUser | undefined;
    this.logger.info(
      { socketId: client.id, userId: profile?.id, orgId: profile?.orgId },
      "Notification socket disconnected"
    );
  }

  private async broadcast(event: NotificationEvent) {
    if (!this.server) {
      return;
    }
    const rooms = [this.orgRoom(event.orgId)];
    if (event.userId) {
      rooms.push(this.userRoom(event.userId));
    }
    this.server.to(rooms).emit("notification", event);
  }

  private verifyToken(token: string): JwtPayload {
    const jwtConfig = this.env.jwtConfig;
    return verify(token, jwtConfig.secret, {
      audience: jwtConfig.audience,
      issuer: jwtConfig.issuer
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

  private orgRoom(orgId: string) {
    return `org:${orgId}`;
  }

  private userRoom(userId: string) {
    return `user:${userId}`;
  }
}
